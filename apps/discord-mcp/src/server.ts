/**
 * Discord MCP server — testable core.
 *
 * This module holds everything that can be exercised without a live Discord
 * connection: the tool definitions, the per-tool handlers (each takes the
 * Discord client as an argument so it can be mocked), the message formatters,
 * the token guard, and `createDiscordServer()` which wires an MCP `Server`.
 *
 * The side-effectful bootstrap (env loading, `discord.login`, stdio transport)
 * lives in `index.ts` so importing this module never touches the network.
 */

import {
    ChannelType,
    type Client,
    type AnyThreadChannel,
    type ForumChannel,
    type TextBasedChannel,
} from "discord.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// ─── token ─────────────────────────────────────────────────────────────────
/**
 * Resolve the Discord bot token, throwing a clear error if it is absent.
 * Reads `DISCORD_MCP_TOKEN` (Nathan's test bot today; the org `DISCORD_TOKEN`
 * is reserved for later org-level provisioning).
 */
export function requireToken(env: NodeJS.ProcessEnv = process.env): string {
    const token = env.DISCORD_MCP_TOKEN;
    if (!token) {
        throw new Error("DISCORD_MCP_TOKEN missing in environment");
    }
    return token;
}

// ─── named id aliases (from env) ───────────────────────────────────────────────
/**
 * Build a map of alias → snowflake id from the environment. Any var named
 * `DISCORD_GUILD_<NAME>` or `DISCORD_CHANNEL_<NAME>` registers `<NAME>` (upper-cased)
 * as an alias for its value, so the weekly-report pull can reference guilds/channels
 * by a stable name (e.g. `CK_SUPPORT`) instead of hardcoding numeric ids.
 *
 * Guild and channel aliases share one namespace — a name collision across the two
 * prefixes is a config error, so we throw rather than silently pick a winner.
 */
export function loadNamedIds(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
    const map = new Map<string, string>();
    for (const [key, value] of Object.entries(env)) {
        const m = /^DISCORD_(?:GUILD|CHANNEL)_(.+)$/.exec(key);
        if (!m) continue;
        const trimmed = value?.trim();
        if (!trimmed) continue;
        const alias = m[1].toUpperCase();
        const existing = map.get(alias);
        if (existing && existing !== trimmed) {
            throw new Error(
                `Discord id alias "${alias}" is defined twice with different values ` +
                    `(${existing} vs ${trimmed}) — check DISCORD_GUILD_/DISCORD_CHANNEL_ env vars.`,
            );
        }
        map.set(alias, trimmed);
    }
    return map;
}

/**
 * Resolve a tool argument to a snowflake id. A raw numeric id passes through
 * untouched (back-compat — callers can always send ids directly); a non-numeric
 * value is looked up as an alias, falling back to itself when unknown so the
 * downstream "not found" / "not a forum channel" errors still fire naturally.
 */
export function resolveId(idOrAlias: string, aliases: Map<string, string>): string {
    if (!idOrAlias || /^\d+$/.test(idOrAlias)) return idOrAlias;
    return aliases.get(idOrAlias.toUpperCase()) ?? idOrAlias;
}

// ─── formatters ──────────────────────────────────────────────────────────────
export function formatReaction(name: string, count: number): string {
    return `${name}(${count})`;
}

export function formatMessage(m: {
    id: string;
    author: string;
    content: string;
    timestamp: string;
    reactions: { emoji: string; count: number }[];
}): string {
    const reactions = m.reactions.length
        ? m.reactions.map((r) => formatReaction(r.emoji, r.count)).join(", ")
        : "No reactions";
    return `${m.author} (${m.timestamp}): ${m.content}\nReactions: ${reactions}`;
}

// ─── tool definitions ────────────────────────────────────────────────────────
export const TOOLS: Tool[] = [
    {
        name: "list_servers",
        description:
            "Get a list of all Discord servers the bot has access to with their details such as name, id, member count, and creation date.",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "get_channels",
        description: "Get a list of all channels in a Discord server",
        inputSchema: {
            type: "object",
            properties: {
                server_id: {
                    type: "string",
                    description:
                        "Discord server (guild) ID, or a configured alias from DISCORD_GUILD_* (e.g. COPILOTKIT)",
                },
            },
            required: ["server_id"],
        },
    },
    {
        name: "list_forum_threads",
        description:
            "List threads in a Discord forum channel (active threads and, optionally, archived ones). Use this before read_thread_messages to discover thread IDs in a forum.",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: {
                    type: "string",
                    description:
                        "Forum channel ID, or a configured alias from DISCORD_CHANNEL_* (e.g. CK_SUPPORT)",
                },
                include_archived: {
                    type: "boolean",
                    description: "Include archived threads (default: true)",
                },
                archived_limit: {
                    type: "number",
                    description: "Max archived threads to fetch (default 50, max 200)",
                    minimum: 1,
                    maximum: 200,
                },
            },
            required: ["channel_id"],
        },
    },
    {
        name: "read_messages",
        description: "Read recent messages from a channel",
        inputSchema: {
            type: "object",
            properties: {
                channel_id: {
                    type: "string",
                    description:
                        "Discord channel ID, or a configured alias from DISCORD_CHANNEL_* (e.g. CK_GENERAL)",
                },
                limit: {
                    type: "number",
                    description: "Number of messages to fetch (max 100)",
                    minimum: 1,
                    maximum: 100,
                },
            },
            required: ["channel_id"],
        },
    },
    {
        name: "read_thread_messages",
        description:
            "Read recent messages from a Discord thread (e.g. a thread inside a forum channel). Pass a thread_id obtained from list_forum_threads.",
        inputSchema: {
            type: "object",
            properties: {
                thread_id: { type: "string", description: "Discord thread ID" },
                limit: {
                    type: "number",
                    description: "Number of messages to fetch (max 100)",
                    minimum: 1,
                    maximum: 100,
                },
            },
            required: ["thread_id"],
        },
    },
];

// ─── tool handlers ───────────────────────────────────────────────────────────
export async function handleListServers(discord: Client): Promise<string> {
    const servers = discord.guilds.cache.map((g) => ({
        id: g.id,
        name: g.name,
        member_count: g.memberCount,
        created_at: g.createdAt.toISOString(),
    }));
    return (
        `Available Servers (${servers.length}):\n` +
        servers
            .map((s) => `${s.name} (ID: ${s.id}, Members: ${s.member_count})`)
            .join("\n")
    );
}

export async function handleGetChannels(
    discord: Client,
    args: { server_id: string },
): Promise<string> {
    const guild = discord.guilds.cache.get(args.server_id);
    if (!guild) return "Guild not found";
    const list = guild.channels.cache
        .map((c) => `#${c.name} (ID: ${c.id}) - ${ChannelType[c.type]}`)
        .join("\n");
    return `Channels in ${guild.name}:\n${list}`;
}

export async function handleListForumThreads(
    discord: Client,
    args: {
        channel_id: string;
        include_archived?: boolean;
        archived_limit?: number;
    },
): Promise<string> {
    const channel = await discord.channels.fetch(args.channel_id);
    if (!channel || channel.type !== ChannelType.GuildForum) {
        return `Channel ${args.channel_id} is not a forum channel.`;
    }
    const forum = channel as ForumChannel;
    const includeArchived = args.include_archived ?? true;
    const archivedLimit = Math.min(args.archived_limit ?? 50, 200);

    const threads: Array<{
        id: string;
        name: string;
        archived: boolean;
        created_at: string | null;
        message_count: number;
        owner_id: string | null;
    }> = [];

    for (const t of forum.threads.cache.values()) {
        threads.push({
            id: t.id,
            name: t.name,
            archived: t.archived ?? false,
            created_at: t.createdAt?.toISOString() ?? null,
            message_count: t.messageCount ?? 0,
            owner_id: t.ownerId ?? null,
        });
    }

    if (includeArchived) {
        const fetched = await forum.threads.fetchArchived({ limit: archivedLimit });
        for (const t of fetched.threads.values()) {
            threads.push({
                id: t.id,
                name: t.name,
                archived: true,
                created_at: t.createdAt?.toISOString() ?? null,
                message_count: t.messageCount ?? 0,
                owner_id: t.ownerId ?? null,
            });
        }
    }

    return (
        `Threads in #${forum.name} (${threads.length}):\n` +
        threads
            .map(
                (t) =>
                    `- ${t.name} (ID: ${t.id}, archived=${t.archived}, msgs=${t.message_count}, created=${t.created_at}, owner=${t.owner_id})`,
            )
            .join("\n")
    );
}

async function fetchHistory(
    channel: TextBasedChannel | AnyThreadChannel,
    limit: number,
): Promise<string> {
    const messages = await channel.messages.fetch({ limit });
    const formatted = messages.map((m) => {
        const reactions = m.reactions.cache.map((r) => ({
            emoji: r.emoji.name ?? r.emoji.id ?? "?",
            count: r.count,
        }));
        return formatMessage({
            id: m.id,
            author: m.author.username,
            content: m.content,
            timestamp: m.createdAt.toISOString(),
            reactions,
        });
    });
    return `Retrieved ${formatted.length} messages:\n\n${formatted.join("\n")}`;
}

export async function handleReadMessages(
    discord: Client,
    args: { channel_id: string; limit?: number },
): Promise<string> {
    const limit = Math.min(args.limit ?? 10, 100);
    const channel = await discord.channels.fetch(args.channel_id);
    if (!channel || !("messages" in channel)) {
        return `Channel ${args.channel_id} is not readable.`;
    }
    return fetchHistory(channel as TextBasedChannel, limit);
}

export async function handleReadThreadMessages(
    discord: Client,
    args: { thread_id: string; limit?: number },
): Promise<string> {
    const limit = Math.min(args.limit ?? 50, 100);
    const channel = await discord.channels.fetch(args.thread_id);
    if (!channel || !channel.isThread()) {
        return `Channel ${args.thread_id} is not a thread.`;
    }
    const thread = channel as AnyThreadChannel;
    const messages = await thread.messages.fetch({ limit });
    const formatted = messages.map((m) => {
        const reactions = m.reactions.cache.map((r) => ({
            emoji: r.emoji.name ?? r.emoji.id ?? "?",
            count: r.count,
        }));
        return formatMessage({
            id: m.id,
            author: m.author.username,
            content: m.content,
            timestamp: m.createdAt.toISOString(),
            reactions,
        });
    });
    return `Thread '${thread.name}' (${formatted.length} messages):\n\n${formatted.join("\n")}`;
}

// ─── MCP server factory ───────────────────────────────────────────────────────
/**
 * Build an MCP `Server` wired to the five read-only Discord tools.
 *
 * @param discord  a connected (or mocked) discord.js Client
 * @param opts.ready  resolves once the client has logged in; CallTool waits on
 *                    it before touching the client. Defaults to already-resolved
 *                    (handy for tests with a synchronous mock).
 */
export function createDiscordServer(
    discord: Client,
    opts: { ready?: Promise<void>; aliases?: Map<string, string> } = {},
): Server {
    const ready = opts.ready ?? Promise.resolve();
    const aliases = opts.aliases ?? loadNamedIds();
    const server = new Server(
        { name: "discord", version: "0.1.0" },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        await ready;
        const { name, arguments: args } = req.params;
        let text: string;
        try {
            switch (name) {
                case "list_servers":
                    text = await handleListServers(discord);
                    break;
                case "get_channels": {
                    const a = args as { server_id: string };
                    text = await handleGetChannels(discord, {
                        ...a,
                        server_id: resolveId(a.server_id, aliases),
                    });
                    break;
                }
                case "list_forum_threads": {
                    const a = args as {
                        channel_id: string;
                        include_archived?: boolean;
                        archived_limit?: number;
                    };
                    text = await handleListForumThreads(discord, {
                        ...a,
                        channel_id: resolveId(a.channel_id, aliases),
                    });
                    break;
                }
                case "read_messages": {
                    const a = args as { channel_id: string; limit?: number };
                    text = await handleReadMessages(discord, {
                        ...a,
                        channel_id: resolveId(a.channel_id, aliases),
                    });
                    break;
                }
                case "read_thread_messages": {
                    const a = args as { thread_id: string; limit?: number };
                    text = await handleReadThreadMessages(discord, {
                        ...a,
                        thread_id: resolveId(a.thread_id, aliases),
                    });
                    break;
                }
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        } catch (err) {
            text = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
        return { content: [{ type: "text", text }] };
    });

    return server;
}

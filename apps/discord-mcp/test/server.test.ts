/**
 * Tests for the Discord MCP server.
 *
 * Strategy:
 *   - Unit-test the pure pieces (token guard, formatters).
 *   - Unit-test each tool handler against a hand-rolled fake Discord client
 *     (no network) so we cover output shaping for every channel/thread type.
 *   - End-to-end test the real MCP protocol layer via the SDK's in-memory
 *     transport: a real MCP Client talks to `createDiscordServer()` over a
 *     linked pipe, exercising listTools + callTool exactly as Claude would.
 *   - A live Discord smoke test, gated behind RUN_DISCORD_LIVE so CI never
 *     needs a bot token.
 */

import { describe, it, expect } from "vitest";
import { ChannelType, type Client } from "discord.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
    requireToken,
    loadNamedIds,
    resolveId,
    formatReaction,
    formatMessage,
    TOOLS,
    handleListServers,
    handleGetChannels,
    handleListForumThreads,
    handleReadMessages,
    handleReadThreadMessages,
    createDiscordServer,
} from "../src/server";

// ─── fakes ─────────────────────────────────────────────────────────────────
// Minimal stand-ins shaped like the bits of discord.js the handlers actually
// touch. Cast to the real types at the boundary with `as unknown as Client`.

type FakeReaction = { emoji: { name: string | null; id: string | null }; count: number };

function fakeMessage(opts: {
    id: string;
    username: string;
    content: string;
    iso: string;
    reactions?: FakeReaction[];
}) {
    const reactions = opts.reactions ?? [];
    return {
        id: opts.id,
        author: { username: opts.username },
        content: opts.content,
        createdAt: new Date(opts.iso),
        reactions: { cache: { map: <T>(fn: (r: FakeReaction) => T) => reactions.map(fn) } },
    };
}

/** A discord.js Collection exposes both `.map()` and `.values()`; arrays give us both cheaply. */
function collection<T>(items: T[]) {
    return {
        map: <R>(fn: (item: T) => R) => items.map(fn),
        values: () => items.values(),
    };
}

function fakeGuild(opts: {
    id: string;
    name: string;
    members: number;
    iso: string;
    channels?: { id: string; name: string; type: ChannelType }[];
}) {
    return {
        id: opts.id,
        name: opts.name,
        memberCount: opts.members,
        createdAt: new Date(opts.iso),
        channels: { cache: collection(opts.channels ?? []) },
    };
}

function fakeDiscord(opts: {
    guilds?: ReturnType<typeof fakeGuild>[];
    channelsById?: Record<string, unknown>;
}) {
    const guilds = opts.guilds ?? [];
    const channelsById = opts.channelsById ?? {};
    return {
        user: { tag: "fake-bot#0001" },
        guilds: {
            cache: {
                map: <R>(fn: (g: ReturnType<typeof fakeGuild>) => R) => guilds.map(fn),
                get: (id: string) => guilds.find((g) => g.id === id),
            },
        },
        channels: {
            fetch: async (id: string) => channelsById[id] ?? null,
        },
    } as unknown as Client;
}

// ─── token guard ─────────────────────────────────────────────────────────────
describe("requireToken", () => {
    it("returns the token when present", () => {
        expect(requireToken({ DISCORD_MCP_TOKEN: "abc" } as NodeJS.ProcessEnv)).toBe("abc");
    });

    it("throws a clear error when missing", () => {
        expect(() => requireToken({} as NodeJS.ProcessEnv)).toThrow(/DISCORD_MCP_TOKEN missing/);
    });
});

// ─── named id aliases ──────────────────────────────────────────────────────
describe("loadNamedIds", () => {
    it("maps DISCORD_GUILD_/DISCORD_CHANNEL_ vars to upper-cased aliases", () => {
        const map = loadNamedIds({
            DISCORD_GUILD_COPILOTKIT: "1122926057641742418",
            DISCORD_CHANNEL_CK_SUPPORT: "1313616713647919218",
            DISCORD_MCP_TOKEN: "secret",
            PATH: "/usr/bin",
        } as unknown as NodeJS.ProcessEnv);
        expect(map.get("COPILOTKIT")).toBe("1122926057641742418");
        expect(map.get("CK_SUPPORT")).toBe("1313616713647919218");
        expect(map.has("MCP_TOKEN")).toBe(false); // DISCORD_MCP_TOKEN is not a guild/channel var
        expect(map.size).toBe(2);
    });

    it("trims values and ignores empty ones", () => {
        const map = loadNamedIds({
            DISCORD_GUILD_AGUI: "  1379082175625953370  ",
            DISCORD_CHANNEL_EMPTY: "   ",
        } as unknown as NodeJS.ProcessEnv);
        expect(map.get("AGUI")).toBe("1379082175625953370");
        expect(map.has("EMPTY")).toBe(false);
    });

    it("allows an alias defined twice with the same value", () => {
        const map = loadNamedIds({
            DISCORD_GUILD_DUP: "123",
            DISCORD_CHANNEL_DUP: "123",
        } as unknown as NodeJS.ProcessEnv);
        expect(map.get("DUP")).toBe("123");
    });

    it("throws when an alias is defined twice with different values", () => {
        expect(() =>
            loadNamedIds({
                DISCORD_GUILD_DUP: "123",
                DISCORD_CHANNEL_DUP: "456",
            } as unknown as NodeJS.ProcessEnv),
        ).toThrow(/defined twice/);
    });
});

describe("resolveId", () => {
    const aliases = new Map([["CK_SUPPORT", "1313616713647919218"]]);

    it("passes a raw numeric id through untouched", () => {
        expect(resolveId("1313616713647919218", aliases)).toBe("1313616713647919218");
    });

    it("resolves a known alias case-insensitively", () => {
        expect(resolveId("ck_support", aliases)).toBe("1313616713647919218");
        expect(resolveId("CK_SUPPORT", aliases)).toBe("1313616713647919218");
    });

    it("falls back to the input when the alias is unknown", () => {
        expect(resolveId("NOPE", aliases)).toBe("NOPE");
    });

    it("passes an empty string through", () => {
        expect(resolveId("", aliases)).toBe("");
    });
});

// ─── formatters ────────────────────────────────────────────────────────────
describe("formatters", () => {
    it("formats a reaction as name(count)", () => {
        expect(formatReaction("👍", 3)).toBe("👍(3)");
    });

    it("formats a message with reactions", () => {
        const out = formatMessage({
            id: "1",
            author: "alice",
            content: "hi",
            timestamp: "2026-06-01T00:00:00.000Z",
            reactions: [{ emoji: "👍", count: 2 }],
        });
        expect(out).toContain("alice (2026-06-01T00:00:00.000Z): hi");
        expect(out).toContain("Reactions: 👍(2)");
    });

    it("says 'No reactions' when there are none", () => {
        const out = formatMessage({
            id: "1",
            author: "bob",
            content: "yo",
            timestamp: "2026-06-01T00:00:00.000Z",
            reactions: [],
        });
        expect(out).toContain("Reactions: No reactions");
    });
});

// ─── tool contract ───────────────────────────────────────────────────────────
describe("TOOLS contract", () => {
    it("exposes exactly the five read-only tools", () => {
        expect(TOOLS.map((t) => t.name).sort()).toEqual(
            [
                "get_channels",
                "list_forum_threads",
                "list_servers",
                "read_messages",
                "read_thread_messages",
            ].sort(),
        );
    });

    it("every tool has a description and an object input schema", () => {
        for (const tool of TOOLS) {
            expect(tool.description, tool.name).toBeTruthy();
            expect(tool.inputSchema.type, tool.name).toBe("object");
        }
    });
});

// ─── handlers ────────────────────────────────────────────────────────────────
describe("handleListServers", () => {
    it("lists guilds with id and member count", async () => {
        const discord = fakeDiscord({
            guilds: [
                fakeGuild({ id: "1", name: "CopilotKit", members: 5381, iso: "2023-01-01T00:00:00Z" }),
                fakeGuild({ id: "2", name: "AG-UI", members: 1335, iso: "2025-05-01T00:00:00Z" }),
            ],
        });
        const out = await handleListServers(discord);
        expect(out).toContain("Available Servers (2):");
        expect(out).toContain("CopilotKit (ID: 1, Members: 5381)");
        expect(out).toContain("AG-UI (ID: 2, Members: 1335)");
    });
});

describe("handleGetChannels", () => {
    it("lists channels with their human-readable type", async () => {
        const discord = fakeDiscord({
            guilds: [
                fakeGuild({
                    id: "1",
                    name: "CopilotKit",
                    members: 1,
                    iso: "2023-01-01T00:00:00Z",
                    channels: [
                        { id: "100", name: "general", type: ChannelType.GuildText },
                        { id: "200", name: "support", type: ChannelType.GuildForum },
                    ],
                }),
            ],
        });
        const out = await handleGetChannels(discord, { server_id: "1" });
        expect(out).toContain("Channels in CopilotKit:");
        expect(out).toContain("#general (ID: 100) - GuildText");
        expect(out).toContain("#support (ID: 200) - GuildForum");
    });

    it("returns 'Guild not found' for an unknown server", async () => {
        const discord = fakeDiscord({ guilds: [] });
        expect(await handleGetChannels(discord, { server_id: "nope" })).toBe("Guild not found");
    });
});

describe("handleListForumThreads", () => {
    const forum = {
        type: ChannelType.GuildForum,
        name: "support",
        threads: {
            cache: collection([
                {
                    id: "t1",
                    name: "Active thread",
                    archived: false,
                    createdAt: new Date("2026-06-01T00:00:00Z"),
                    messageCount: 4,
                    ownerId: "u1",
                },
            ]),
            fetchArchived: async () => ({
                threads: collection([
                    {
                        id: "t2",
                        name: "Old thread",
                        archived: true,
                        createdAt: new Date("2026-05-01T00:00:00Z"),
                        messageCount: 9,
                        ownerId: "u2",
                    },
                ]),
            }),
        },
    };

    it("includes active and archived threads by default", async () => {
        const discord = fakeDiscord({ channelsById: { f1: forum } });
        const out = await handleListForumThreads(discord, { channel_id: "f1" });
        expect(out).toContain("Threads in #support (2):");
        expect(out).toContain("Active thread (ID: t1, archived=false, msgs=4");
        expect(out).toContain("Old thread (ID: t2, archived=true, msgs=9");
    });

    it("skips archived threads when include_archived is false", async () => {
        const discord = fakeDiscord({ channelsById: { f1: forum } });
        const out = await handleListForumThreads(discord, {
            channel_id: "f1",
            include_archived: false,
        });
        expect(out).toContain("Threads in #support (1):");
        expect(out).toContain("Active thread");
        expect(out).not.toContain("Old thread");
    });

    it("rejects a non-forum channel", async () => {
        const discord = fakeDiscord({
            channelsById: { c1: { type: ChannelType.GuildText, name: "general" } },
        });
        const out = await handleListForumThreads(discord, { channel_id: "c1" });
        expect(out).toBe("Channel c1 is not a forum channel.");
    });
});

describe("handleReadMessages", () => {
    it("formats fetched messages", async () => {
        const channel = {
            messages: {
                fetch: async () =>
                    collection([
                        fakeMessage({
                            id: "m1",
                            username: "alice",
                            content: "hello",
                            iso: "2026-06-01T00:00:00.000Z",
                            reactions: [{ emoji: { name: "👍", id: null }, count: 1 }],
                        }),
                    ]),
            },
        };
        const discord = fakeDiscord({ channelsById: { c1: channel } });
        const out = await handleReadMessages(discord, { channel_id: "c1" });
        expect(out).toContain("Retrieved 1 messages:");
        expect(out).toContain("alice (2026-06-01T00:00:00.000Z): hello");
        expect(out).toContain("👍(1)");
    });

    it("rejects a non-readable channel", async () => {
        const discord = fakeDiscord({ channelsById: { c1: { name: "voice" } } });
        expect(await handleReadMessages(discord, { channel_id: "c1" })).toBe(
            "Channel c1 is not readable.",
        );
    });
});

describe("handleReadThreadMessages", () => {
    it("formats messages from a thread", async () => {
        const thread = {
            isThread: () => true,
            name: "passing headers",
            messages: {
                fetch: async () =>
                    collection([
                        fakeMessage({
                            id: "m1",
                            username: "graypainter",
                            content: "Solved.",
                            iso: "2026-06-05T00:00:00.000Z",
                        }),
                    ]),
            },
        };
        const discord = fakeDiscord({ channelsById: { t1: thread } });
        const out = await handleReadThreadMessages(discord, { thread_id: "t1" });
        expect(out).toContain("Thread 'passing headers' (1 messages):");
        expect(out).toContain("graypainter (2026-06-05T00:00:00.000Z): Solved.");
    });

    it("rejects a channel that is not a thread", async () => {
        const discord = fakeDiscord({ channelsById: { t1: { isThread: () => false } } });
        expect(await handleReadThreadMessages(discord, { thread_id: "t1" })).toBe(
            "Channel t1 is not a thread.",
        );
    });
});

// ─── MCP protocol e2e (in-memory transport, no network) ──────────────────────
describe("MCP protocol (in-memory)", () => {
    async function connect(discord: Client, aliases?: Map<string, string>) {
        const server = createDiscordServer(discord, aliases ? { aliases } : {});
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const client = new McpClient(
            { name: "test-client", version: "0.0.0" },
            { capabilities: {} },
        );
        await client.connect(clientTransport);
        return { client, server };
    }

    it("lists the five tools over the wire", async () => {
        const { client } = await connect(fakeDiscord({ guilds: [] }));
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(
            [
                "get_channels",
                "list_forum_threads",
                "list_servers",
                "read_messages",
                "read_thread_messages",
            ].sort(),
        );
    });

    it("calls list_servers and returns formatted text content", async () => {
        const discord = fakeDiscord({
            guilds: [fakeGuild({ id: "1", name: "CopilotKit", members: 5381, iso: "2023-01-01T00:00:00Z" })],
        });
        const { client } = await connect(discord);
        const res = (await client.callTool({ name: "list_servers", arguments: {} })) as {
            content: { type: string; text: string }[];
        };
        expect(res.content[0].type).toBe("text");
        expect(res.content[0].text).toContain("CopilotKit (ID: 1, Members: 5381)");
    });

    it("resolves a guild alias in get_channels args to the real id", async () => {
        const discord = fakeDiscord({
            guilds: [
                fakeGuild({
                    id: "1122926057641742418",
                    name: "CopilotKit",
                    members: 5381,
                    iso: "2023-01-01T00:00:00Z",
                    channels: [{ id: "100", name: "general", type: ChannelType.GuildText }],
                }),
            ],
        });
        const { client } = await connect(
            discord,
            new Map([["COPILOTKIT", "1122926057641742418"]]),
        );
        const res = (await client.callTool({
            name: "get_channels",
            arguments: { server_id: "COPILOTKIT" },
        })) as { content: { type: string; text: string }[] };
        expect(res.content[0].text).toContain("Channels in CopilotKit:");
        expect(res.content[0].text).toContain("#general (ID: 100)");
    });

    it("surfaces handler errors as text instead of throwing", async () => {
        const { client } = await connect(fakeDiscord({ guilds: [] }));
        const res = (await client.callTool({ name: "made_up_tool", arguments: {} })) as {
            content: { type: string; text: string }[];
        };
        expect(res.content[0].text).toContain("Error: Unknown tool: made_up_tool");
    });
});

// ─── live Discord smoke test (opt-in) ─────────────────────────────────────────
// Run with: RUN_DISCORD_LIVE=1 DISCORD_MCP_TOKEN=... pnpm --filter @copilotkit/outpost-discord-mcp test
// Skipped by default so CI needs no bot token / network.
describe.skipIf(!process.env.RUN_DISCORD_LIVE)("live Discord smoke", () => {
    it("logs in and lists at least one server", async () => {
        const { Client, GatewayIntentBits } = await import("discord.js");
        const discord = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
            ],
        });
        const ready = new Promise<void>((res) => discord.once("ready", () => res()));
        await discord.login(requireToken());
        await ready;
        try {
            const out = await handleListServers(discord);
            expect(out).toMatch(/Available Servers \(\d+\):/);
            expect(out).not.toContain("Available Servers (0):");
        } finally {
            await discord.destroy();
        }
    }, 30_000);
});

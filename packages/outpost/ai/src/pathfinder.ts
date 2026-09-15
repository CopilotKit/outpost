import type { SearchResult, PathfinderQuery } from './types.js';
import { config } from './config.js';

/**
 * Turn a code hit's REPOSITORY + PATH into a link a reader can open.
 *
 * The doc is explicit that this matters: *"if the answer only exists in the
 * source, link the file in the repo. A repo link is a real answer; a non-answer
 * is not."* Without a URL a code-sourced answer has nothing to cite, and the
 * reply rules then require it to collapse into a two-sentence handoff — so the
 * retrieval would succeed and the answer would still be withheld.
 *
 * Assumes the default branch is `main`, which holds for CopilotKit/CopilotKit
 * and ag-ui-protocol/ag-ui. A blob URL on a wrong branch 404s rather than
 * pointing somewhere misleading, and the tool response carries no ref, so this
 * is the best available and fails visibly.
 */
function blobUrl(repository: string | undefined, path: string | undefined): string | undefined {
    if (!path) return undefined;
    // Logged rather than silently dropped. If the server ever emits a bare slug
    // (`CopilotKit/CopilotKit`), an SSH remote, or omits REPOSITORY for one index,
    // EVERY code hit arrives with nothing to cite — and the reply rules then
    // collapse a correct code-grounded answer into a two-sentence handoff. That is
    // the same silent-degradation shape this whole change exists to remove, so it
    // has to leave a trace.
    const repo = repository?.replace(/\.git$/, '').replace(/\/$/, '');
    if (!repo || !/^https?:\/\/github\.com\//i.test(repo)) {
        console.warn(
            `[Pathfinder] code hit for "${path}" has no usable REPOSITORY ` +
                `(got ${repository === undefined ? 'nothing' : JSON.stringify(repository)}), ` +
                `so it reaches the prompt with no citable URL.`,
        );
        return undefined;
    }
    return `${repo}/blob/main/${path.replace(/^\/+/, '')}`;
}

/**
 * Cap what goes out as an MCP search `query`.
 *
 * The relay forwards a whole GitHub issue body as the retrieval string. That is
 * wrong twice over. It is bad retrieval — a 3.3 KB marketing blob scored 0.33
 * cosine against our docs, worse than the one-line questions it sits beside —
 * and it is an amplification channel: whatever an anonymous stranger types
 * arrives verbatim in Pathfinder's `query_log`, its Top Queries panel, the
 * weekly Notion report, and the monthly gap-analysis LLM prompt. Capping it is
 * content-independent: it bounds the NEXT campaign too, whatever it advertises.
 *
 * The head is kept rather than the tail because the opening sentences are where
 * the question lives — a bug report leads with the symptom and trails into
 * environment dumps. The cut is pulled back to the last whitespace in the final
 * 15% so a query does not end mid-token, which is noise to an embedding.
 *
 * Exported for the test that proves the cap actually reaches the wire.
 */
export function capQuery(query: string, maxChars: number): string {
    if (maxChars <= 0 || query.length <= maxChars) return query;
    const head = query.slice(0, maxChars);
    const lastSpace = head.search(/\s\S*$/);
    return (lastSpace > maxChars * 0.85 ? head.slice(0, lastSpace) : head).trimEnd();
}

/**
 * The Pathfinder search tools, verified against `tools/list` on
 * https://mcp.copilotkit.ai/mcp. All four take the same arguments
 * (`query`, `limit`, `min_score`, `version`).
 */
type SearchTool = 'search-docs' | 'search-code' | 'search-ag-ui-docs' | 'search-ag-ui-code';

/**
 * Pathfinder MCP client for CopilotKit + AG-UI retrieval, over docs AND source.
 *
 * Uses the MCP **Streamable HTTP** transport: a single `POST {mcpUrl}/mcp`
 * endpoint. The session id is returned in the `Mcp-Session-Id` response header
 * on `initialize` and echoed on every subsequent request.
 *
 * NOTE: the server also exposes a legacy SSE endpoint (`GET {mcpUrl}/sse`), but
 * that is a long-lived `text/event-stream` — reading it to completion blocks
 * until the request timeout aborts ("This operation was aborted"), so it is NOT
 * used. Streamable-HTTP replies are finite and close immediately, so reading the
 * body never hangs.
 *
 * Falls back to a plain-text docs search when MCP is unavailable.
 */
export class PathfinderClient {
    private readonly endpoint: string;
    private sessionId: string | null = null;
    private sessionCreatedAt = 0;
    private connecting: Promise<void> | null = null;
    private nextId = 1;

    constructor(mcpUrl?: string) {
        const base = mcpUrl ?? config.pathfinderMcpUrl;
        this.endpoint = `${base}/mcp`;
    }

    /**
     * Initialize the MCP session. Reuses an existing session while it is valid.
     */
    async connect(): Promise<void> {
        if (this.sessionId && !this.isSessionExpired()) {
            return;
        }
        // Deduplicate concurrent connect calls.
        if (this.connecting) {
            return this.connecting;
        }
        this.connecting = this.doConnect();
        try {
            await this.connecting;
        } finally {
            this.connecting = null;
        }
    }

    private async doConnect(): Promise<void> {
        // Clear any stale session before (re-)initializing: `initialize` is what
        // mints a session, so it must not carry an old `Mcp-Session-Id` (a server
        // MAY answer a terminated id with 404). Resetting up front also means a
        // throwing re-init leaves clean state instead of a dead session id that
        // would fall back forever.
        this.reset();

        const { body, sessionId } = await this.post(
            {
                jsonrpc: '2.0',
                id: this.nextId++,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'outpost', version: '1.0.0' },
                },
            },
            // Identify the relay. Pathfinder reads `X-Pathfinder-Source` only on
            // the request that mints the session and closes over it for every
            // later tool call, so `initialize` is the one place it can be set.
            { 'X-Pathfinder-Source': config.pathfinder.sourceTag },
        );

        const parsed = this.parseJsonRpc(body);
        if (parsed.error) {
            this.reset();
            throw new Error(`MCP connection failed: ${parsed.error.message}`);
        }
        if (!sessionId) {
            this.reset();
            throw new Error('MCP connection failed: server did not return a session id');
        }

        this.sessionId = sessionId;
        this.sessionCreatedAt = Date.now();

        // Best-effort "initialized" notification — the session is already usable,
        // so a failure here is non-fatal.
        try {
            await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
        } catch {
            // ignore
        }
    }

    /**
     * Check if the current session has expired or needs refresh.
     */
    private isSessionExpired(): boolean {
        if (!this.sessionId) return true;
        const elapsed = Date.now() - this.sessionCreatedAt;
        return elapsed >= config.pathfinder.sessionTtlMs - config.pathfinder.refreshBeforeExpiryMs;
    }

    /**
     * POST a JSON-RPC message to the Streamable-HTTP endpoint with a hard
     * timeout. Returns the raw body text and the `Mcp-Session-Id` response
     * header (present on `initialize`).
     */
    private async post(
        message: Record<string, unknown>,
        extraHeaders?: Record<string, string>,
    ): Promise<{ body: string; sessionId: string | null }> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.pathfinder.requestTimeoutMs);

        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
            };
            if (this.sessionId) {
                headers['Mcp-Session-Id'] = this.sessionId;
            }
            Object.assign(headers, extraHeaders);

            const response = await fetch(this.endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(message),
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
            }

            // Safe to read to completion: Streamable-HTTP replies are finite.
            const body = await response.text();
            return { body, sessionId: response.headers.get('mcp-session-id') };
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                throw new Error(
                    `MCP request timed out after ${config.pathfinder.requestTimeoutMs}ms`,
                );
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Parse a JSON-RPC reply body. Streamable HTTP may return either a plain
     * JSON object or an SSE-framed reply (`data: {...}`) that closes immediately;
     * handle both.
     */
    private parseJsonRpc(body: string): { result?: unknown; error?: { message: string } } {
        const trimmed = body.trim();
        if (!trimmed) return {};

        if (!trimmed.startsWith('{')) {
            const data = trimmed
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice('data:'.length).trim())
                .join('');
            if (data) {
                return JSON.parse(data) as { result?: unknown; error?: { message: string } };
            }
        }

        return JSON.parse(trimmed) as { result?: unknown; error?: { message: string } };
    }

    /**
     * Call an MCP tool on the Pathfinder server.
     */
    private async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
        await this.connect();

        let body: string;
        try {
            ({ body } = await this.post({
                jsonrpc: '2.0',
                id: this.nextId++,
                method: 'tools/call',
                params: {
                    name: toolName,
                    arguments: args,
                },
            }));
        } catch (error) {
            // Force a fresh session on the next call after any transport failure.
            this.reset();
            throw error;
        }

        const parsed = this.parseJsonRpc(body);
        if (parsed.error) {
            this.reset();
            throw new Error(`MCP error: ${parsed.error.message}`);
        }
        return parsed.result;
    }

    /**
     * Parse an MCP tool result into a SearchResult array.
     *
     * The current `copilotkit-docs-mcp` server returns content as text blocks:
     *
     *   SNIPPET 1
     *   TITLE: ...
     *   SOURCE: ...
     *   CONTENT:
     *   ...
     *   ---
     *   SNIPPET 2
     *   ...
     *
     * An older format returned a JSON array; both are supported.
     */
    private parseSearchResults(result: unknown): SearchResult[] {
        const typed = result as { content?: Array<{ text?: string }> } | undefined;
        if (!typed?.content?.length) return [];

        const text = typed.content
            .filter((c) => c.text)
            .map((c) => c.text)
            .join('\n');

        if (!text.trim()) return [];

        // Legacy JSON-array format.
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
                return parsed.map((item: Record<string, unknown>) => ({
                    title: String(item.title ?? item.name ?? 'Untitled'),
                    content: String(item.content ?? item.snippet ?? item.text ?? ''),
                    score: Number(item.similarity ?? item.score ?? item.relevance ?? 0),
                    sourceUrl: item.sourceUrl
                        ? String(item.sourceUrl)
                        : item.url
                          ? String(item.url)
                          : undefined,
                    category: item.category ? String(item.category) : undefined,
                }));
            }
        } catch {
            // Not JSON — fall through to SNIPPET parsing.
        }

        return this.parseSnippets(text);
    }

    /**
     * Parse the SNIPPET/TITLE/SOURCE/CONTENT text format. The MCP text format
     * carries no numeric relevance score, so a descending rank score is
     * synthesized (results are already server-filtered by min_score) to give
     * the confidence heuristic a usable signal.
     */
    private parseSnippets(text: string): SearchResult[] {
        // Split on the structural "SNIPPET <n>" marker rather than the "---"
        // separator: doc content itself commonly contains a "---" horizontal
        // rule, and splitting on that would truncate the snippet at the rule.
        // The "SNIPPET <n>" header never appears inside content.
        const blocks = text
            .split(/^SNIPPET\s+\d+\s*$/im)
            .map((b) => b.trim())
            // A docs block carries TITLE, a code block carries PATH and no TITLE.
            // Requiring TITLE alone silently dropped every code hit, so
            // `searchCode` returned [] while looking like it had worked.
            .filter((b) => /TITLE:/i.test(b) || /PATH:/i.test(b));

        return blocks.map((block, i) => {
            // Headers are read ONLY from the part above `CONTENT:`, never from the
            // body. Anchoring the patterns to a line start is not enough on its
            // own, in either direction:
            //
            //   - a code body is source code, where `title: "Chat"` and
            //     `source: 'user'` are everyday object literals;
            //   - a docs body quotes source code, so a line-initial `path:` —
            //     `copilotRuntimeNextJSAppRouter({ path: "/api/copilotkit" })` is
            //     in the self-hosting guide — reads as a PATH header and makes the
            //     block look like code, which took the docs URL away with it.
            //
            // Splitting first removes the whole class rather than the two spellings
            // that happened to be noticed.
            const contentAt = block.search(/^\s*CONTENT:/im);
            const headerRegion = contentAt === -1 ? block : block.slice(0, contentAt);

            const header = (name: string): string | undefined =>
                headerRegion.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'im'))?.[1]?.trim();

            const titleHeader = header('TITLE');
            const path = header('PATH');
            const repository = header('REPOSITORY');

            // A code block is the one with a PATH and no TITLE. Derived from the
            // headers rather than from PATH alone, so a docs block can never be
            // mistaken for code and lose its citable URL.
            //
            // This depends on a server-side contract we do not own: that a code
            // hit never carries a TITLE. It holds against the current
            // `tools/list` on mcp.copilotkit.ai. If a code result ever gains one,
            // `isCode` goes false, `source` falls back to `header('SOURCE')`
            // — absent on a code block — and the file path silently stops being
            // citable, which the reply rules then turn into a handoff. The
            // both-headers case is pinned in pathfinder.test.ts so the change in
            // behaviour is visible rather than silent.
            const isCode = !titleHeader && !!path;

            const title = titleHeader ?? path ?? 'Documentation';
            const source = isCode ? blobUrl(repository, path) : header('SOURCE');
            const contentMatch = block.match(/CONTENT:\s*([\s\S]*)$/i);
            const content = (contentMatch ? contentMatch[1] : block)
                // Strip the trailing "---" separator that precedes the next snippet.
                .replace(/\n\s*-{3,}\s*$/, '')
                .trim();

            return {
                title,
                content,
                score: Math.max(0.5, 1 - i * 0.05),
                sourceUrl: source || undefined,
                category: undefined,
                // Carried so the prompt can label the two apart. GROUNDING_RULES
                // now says "code entries are shown with their file path" and tells
                // the model the code wins a conflict with the docs — neither is
                // actionable if both render as an identical `[Source N: title]`.
                kind: isCode ? ('code' as const) : ('docs' as const),
            };
        });
    }

    /**
     * The four search tools share one schema, so they share one implementation.
     *
     * Kept private with named wrappers rather than exposed as a tool-name
     * parameter, so a caller cannot invent a name that fails at the wire.
     *
     * That is a narrow guarantee, and worth not overstating: `SearchTool` is a
     * compile-time union and cannot know what the server actually exposes. A
     * server-side rename of `search-code` still produces a JSON-RPC error, one
     * `console.error`, and `[]` — indistinguishable from "no code matched" for as
     * long as nobody reads the logs. Making that checkable needs a `tools/list`
     * probe at startup; tracked in #244.
     */
    private async search(tool: SearchTool, query: PathfinderQuery): Promise<SearchResult[]> {
        try {
            const result = await this.callTool(tool, {
                query: capQuery(query.query, config.pathfinder.maxQueryChars),
                limit: query.limit ?? config.pathfinder.defaultLimit,
                min_score: query.minScore ?? config.pathfinder.defaultMinScore,
            });
            return this.parseSearchResults(result);
        } catch (error) {
            console.error(
                `[Pathfinder] ${tool} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return [];
        }
    }

    /**
     * Search CopilotKit's SOURCE, not its docs.
     *
     * The gap this closes: for any question whose answer lives in the code —
     * most of the hard ones — the agent had only the docs and was otherwise
     * guessing from general React knowledge. A reporter asked whether Deep
     * Agents supports subagents; the docs do not mention it, so the agent said
     * it had no timeline and sent them to GitHub to ask. Subagents work today
     * and one code search returns the proof.
     */
    async searchCode(query: PathfinderQuery): Promise<SearchResult[]> {
        return this.search('search-code', query);
    }

    /** Search AG-UI's source. Same reasoning as `searchCode`, other repo. */
    async searchAgUiCode(query: PathfinderQuery): Promise<SearchResult[]> {
        return this.search('search-ag-ui-code', query);
    }

    /** Search AG-UI's docs. */
    async searchAgUiDocs(query: PathfinderQuery): Promise<SearchResult[]> {
        return this.search('search-ag-ui-docs', query);
    }

    /**
     * Search documentation using Pathfinder's semantic search.
     */
    async searchDocs(query: PathfinderQuery): Promise<SearchResult[]> {
        try {
            const result = await this.callTool('search-docs', {
                query: capQuery(query.query, config.pathfinder.maxQueryChars),
                limit: query.limit ?? config.pathfinder.defaultLimit,
                min_score: query.minScore ?? config.pathfinder.defaultMinScore,
            });
            return this.parseSearchResults(result);
        } catch (error) {
            console.error(
                `[Pathfinder] searchDocs failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return this.fallbackSearch(query.query);
        }
    }

    /**
     * Explore documentation tree structure.
     */
    async exploreDocs(command: string): Promise<SearchResult[]> {
        try {
            const result = await this.callTool('explore-docs', { command });
            return this.parseSearchResults(result);
        } catch (error) {
            console.error(
                `[Pathfinder] exploreDocs failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return [];
        }
    }

    /**
     * Query the knowledge base for FAQ retrieval.
     */
    async queryKnowledgeBase(query?: string): Promise<SearchResult[]> {
        try {
            const result = await this.callTool('knowledge-base', {
                query: query ?? '',
            });
            return this.parseSearchResults(result);
        } catch (error) {
            console.error(
                `[Pathfinder] queryKnowledgeBase failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return [];
        }
    }

    /**
     * Fallback: fetch /llms-full.txt and do basic text search when MCP is unavailable.
     */
    async fallbackSearch(query: string): Promise<SearchResult[]> {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(
                () => controller.abort(),
                config.pathfinder.requestTimeoutMs,
            );

            const response = await fetch(config.fallbackDocsUrl, {
                signal: controller.signal,
            });
            clearTimeout(timeout);

            if (!response.ok) {
                console.error(
                    `[Pathfinder] Fallback docs fetch returned HTTP ${response.status} ${response.statusText}`,
                );
                return [];
            }

            const text = await response.text();
            return this.textSearch(text, query);
        } catch (error) {
            console.error(
                `[Pathfinder] Fallback search failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return [];
        }
    }

    /**
     * Simple text search over a large document. Splits by sections and scores
     * by keyword overlap.
     */
    private textSearch(document: string, query: string): SearchResult[] {
        const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (queryTerms.length === 0) return [];

        // Split document by headings (markdown ## or #)
        const sections = document.split(/(?=^#{1,3}\s)/m).filter((s) => s.trim().length > 50);

        const scored = sections.map((section) => {
            const lower = section.toLowerCase();
            const matchCount = queryTerms.filter((term) => lower.includes(term)).length;
            const score = matchCount / queryTerms.length;

            // Extract title from first line
            const firstLine = section
                .split('\n')[0]
                .replace(/^#+\s*/, '')
                .trim();

            return {
                title: firstLine || 'Documentation',
                content: section.slice(0, 1500),
                score,
                sourceUrl: undefined,
                category: undefined,
            };
        });

        return scored
            .filter((s) => s.score > 0.2)
            .sort((a, b) => b.score - a.score)
            .slice(0, config.pathfinder.defaultLimit);
    }

    private reset(): void {
        this.sessionId = null;
        this.sessionCreatedAt = 0;
    }

    /**
     * Disconnect and clean up the session.
     */
    disconnect(): void {
        this.reset();
    }
}

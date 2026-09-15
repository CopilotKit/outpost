import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PathfinderClient, capQuery } from './pathfinder.js';
import { config } from './config.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const BASE = 'https://test-mcp.example.com';
const MCP = `${BASE}/mcp`;

/** Build a minimal fetch Response-like object. */
function mkResp(opts: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    body?: string;
    sessionId?: string | null;
}) {
    const { ok = true, status = 200, statusText = 'OK', body = '', sessionId = null } = opts;
    return {
        ok,
        status,
        statusText,
        text: async () => body,
        headers: {
            get: (k: string) => (k.toLowerCase() === 'mcp-session-id' ? sessionId : null),
        },
    };
}

function jsonRpc(result: unknown, id = 1): string {
    return JSON.stringify({ jsonrpc: '2.0', id, result });
}

/** initialize (with session header) + initialized notification responses. */
function mockConnect(sessionId = 'sess-123') {
    mockFetch.mockResolvedValueOnce(
        mkResp({ body: jsonRpc({ protocolVersion: '2024-11-05', capabilities: {} }), sessionId }),
    );
    mockFetch.mockResolvedValueOnce(mkResp({ body: '' })); // notifications/initialized
}

describe('PathfinderClient', () => {
    let client: PathfinderClient;

    beforeEach(() => {
        client = new PathfinderClient(BASE);
        mockFetch.mockReset();
    });

    afterEach(() => {
        client.disconnect();
    });

    describe('connect', () => {
        it('initializes an MCP session via POST /mcp and captures the session header', async () => {
            mockConnect('sess-abc');

            await client.connect();

            const [url, init] = mockFetch.mock.calls[0];
            expect(url).toBe(MCP);
            expect(init.method).toBe('POST');
            expect(String(init.body)).toContain('"method":"initialize"');
        });

        it('reuses the existing session on subsequent connect calls', async () => {
            mockConnect();

            await client.connect();
            await client.connect();

            const initCalls = mockFetch.mock.calls.filter(([, init]) =>
                String(init.body).includes('"method":"initialize"'),
            );
            expect(initCalls).toHaveLength(1);
        });

        it('does not carry a stale session id when re-initializing after expiry', async () => {
            let now = 1_000_000;
            const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
            try {
                mockConnect('sess-1');
                await client.connect();

                // Advance past the 25-min refresh window so the session is expired.
                now += 26 * 60 * 1000;

                mockConnect('sess-2');
                mockFetch.mockResolvedValueOnce(
                    mkResp({ body: jsonRpc({ content: [{ text: '[]' }] }, 2) }),
                );
                await client.searchDocs({ query: 'x' });

                const initCalls = mockFetch.mock.calls.filter(([, init]) =>
                    String(init.body).includes('"method":"initialize"'),
                );
                expect(initCalls).toHaveLength(2);
                // The re-init must NOT echo the expired session id — `initialize`
                // mints a fresh session, and a terminated id may be rejected (404).
                expect(initCalls[1][1].headers['Mcp-Session-Id']).toBeUndefined();
            } finally {
                nowSpy.mockRestore();
            }
        });

        it('throws when the initialize request is not ok', async () => {
            mockFetch.mockResolvedValueOnce(
                mkResp({ ok: false, status: 503, statusText: 'Service Unavailable' }),
            );

            await expect(client.connect()).rejects.toThrow('MCP request failed');
        });

        it('throws when the server returns no session id', async () => {
            mockFetch.mockResolvedValueOnce(mkResp({ body: jsonRpc({}), sessionId: null }));

            await expect(client.connect()).rejects.toThrow('did not return a session id');
        });

        it('surfaces a clear timeout error when the request aborts', async () => {
            mockFetch.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));

            await expect(client.connect()).rejects.toThrow('timed out');
        });
    });

    // The code-search tools return a DIFFERENT snippet shape than the docs
    // tools: REPOSITORY/PATH/CONTENT, with no TITLE line. `parseSnippets` used to
    // require /TITLE:/ to accept a block, so every code hit was dropped on the
    // floor and searchCode returned [] while looking like it had worked — a
    // retrieval source that silently contributes nothing is worse than one that
    // errors, because the answer just quietly has less to stand on.
    const CODE_SNIPPETS = [
        'SNIPPET 1',
        'REPOSITORY: https://github.com/CopilotKit/CopilotKit.git',
        'PATH: packages/core/src/core/run-handler.ts',
        'CONTENT:',
        '// File: packages/core/src/core/run-handler.ts',
        '1114 |     const agent = this._internal.getAgent(resolvedAgentId);',
        '',
        'SNIPPET 2',
        'REPOSITORY: https://github.com/CopilotKit/CopilotKit.git',
        'PATH: packages/runtime/src/langgraph/agent.ts',
        'CONTENT:',
        'export function streamSubgraphEvents() {}',
    ].join('\n');

    describe('searchCode', () => {
        it('parses the REPOSITORY/PATH/CONTENT shape the code tools actually return', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ body: jsonRpc({ content: [{ type: 'text', text: CODE_SNIPPETS }] }) }),
            );

            const results = await client.searchCode({ query: 'subagent task tool' });

            expect(results).toHaveLength(2);
            // The file path is the only human-meaningful title a code hit has.
            expect(results[0].title).toBe('packages/core/src/core/run-handler.ts');
            expect(results[0].content).toContain('getAgent(resolvedAgentId)');
            expect(results[1].title).toBe('packages/runtime/src/langgraph/agent.ts');
        });

        // "If the answer only exists in the source, link the file in the repo. A
        // repo link is a real answer." So the blob URL has to be built, or the
        // reply has nothing to cite and collapses to a handoff.
        it('builds a repo blob URL so the reply has something to cite', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ body: jsonRpc({ content: [{ type: 'text', text: CODE_SNIPPETS }] }) }),
            );

            const results = await client.searchCode({ query: 'x' });

            expect(results[0].sourceUrl).toBe(
                'https://github.com/CopilotKit/CopilotKit/blob/main/packages/core/src/core/run-handler.ts',
            );
        });

        // The header regexes were unanchored, so the first `title:`/`source:`
        // ANYWHERE in the block won — and a code block's body is source code,
        // where `title: "Chat"` and `source: 'user'` are everyday object
        // literals. A real run-handler.ts came back titled `"Chat", source:
        // 'user' };` with sourceUrl `'user' };`, which went into the prompt as
        // `[Source 1: "Chat", source: 'user' };] URL: 'user' };` and buried the
        // file path the reply was supposed to cite.
        it('is not fooled by title: or source: appearing inside the code itself', async () => {
            const withLiterals = [
                'SNIPPET 1',
                'REPOSITORY: https://github.com/CopilotKit/CopilotKit.git',
                'PATH: packages/core/src/core/run-handler.ts',
                'CONTENT:',
                '  12 |   const card = { title: "Chat", source: \'user\' };',
            ].join('\n');

            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ body: jsonRpc({ content: [{ type: 'text', text: withLiterals }] }) }),
            );

            const results = await client.searchCode({ query: 'x' });

            expect(results[0].title).toBe('packages/core/src/core/run-handler.ts');
            expect(results[0].sourceUrl).toBe(
                'https://github.com/CopilotKit/CopilotKit/blob/main/packages/core/src/core/run-handler.ts',
            );
        });

        it('marks a code hit as code so the prompt can label it', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ body: jsonRpc({ content: [{ type: 'text', text: CODE_SNIPPETS }] }) }),
            );

            const results = await client.searchCode({ query: 'x' });

            expect(results[0].kind).toBe('code');
        });

        it('calls the search-code tool, not search-docs', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ body: jsonRpc({ content: [{ type: 'text', text: CODE_SNIPPETS }] }) }),
            );

            await client.searchCode({ query: 'subagent' });

            const body = JSON.parse(mockFetch.mock.calls[2][1].body);
            expect(body.params.name).toBe('search-code');
            expect(body.params.arguments.query).toBe('subagent');
        });

        it('returns [] rather than throwing when the tool errors', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        error: { message: 'index unavailable' },
                    }),
                }),
            );

            await expect(client.searchCode({ query: 'x' })).resolves.toEqual([]);
        });
    });

    // The mirror image of the code-block fix, and the reason headers are now read
    // only from above CONTENT:. A docs body quotes source code, so a line-initial
    // `path:` — `copilotRuntimeNextJSAppRouter({ path: "/api/copilotkit" })` is in
    // the self-hosting guide — used to read as a PATH header, make the block look
    // like code, and take the docs URL away with it. A docs page that loses its URL
    // cannot be cited, and the reply rules then collapse the answer into a handoff.
    describe('docs blocks whose content quotes code', () => {
        const DOCS_QUOTING_CODE = [
            'SNIPPET 1',
            'TITLE: Self-hosting the CopilotKit Runtime',
            'SOURCE: https://docs.copilotkit.ai/guides/self-hosting',
            'CONTENT:',
            '```ts',
            'const handler = copilotRuntimeNextJSAppRouter({',
            '  path: "/api/copilotkit",',
            '});',
            '```',
        ].join('\n');

        it('keeps the real title when the body contains a line-initial path:', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ body: jsonRpc({ content: [{ type: 'text', text: DOCS_QUOTING_CODE }] }) }),
            );

            const results = await client.searchDocs({ query: 'self hosting' });

            expect(results[0].title).toBe('Self-hosting the CopilotKit Runtime');
        });

        it('keeps the docs URL rather than trying to build a blob URL', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ body: jsonRpc({ content: [{ type: 'text', text: DOCS_QUOTING_CODE }] }) }),
            );

            const results = await client.searchDocs({ query: 'self hosting' });

            expect(results[0].sourceUrl).toBe('https://docs.copilotkit.ai/guides/self-hosting');
        });

        it('classifies it as docs, not code', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ body: jsonRpc({ content: [{ type: 'text', text: DOCS_QUOTING_CODE }] }) }),
            );

            const results = await client.searchDocs({ query: 'self hosting' });

            expect(results[0].kind).toBe('docs');
        });
    });

    // Three layers independently prevent a docs block being read as code: the
    // title prefers TITLE over PATH, `isCode` requires the absence of TITLE, and
    // headers are read only from above CONTENT:. That redundancy is deliberate,
    // and it means no single one of them is pinned by the docs-quoting-code test
    // above — reverting any one alone leaves the suite green. These two isolate a
    // layer each, so simplifying one away is visible.
    describe('each structural layer, isolated', () => {
        // Isolates the title order and `isCode`. A block carrying BOTH headers is
        // the shape that appears if the server ever gives code hits a title —
        // a contract we do not own. It must read as docs and keep its SOURCE.
        it('treats a block with both TITLE and PATH as docs', async () => {
            const both = [
                'SNIPPET 1',
                'TITLE: Self-hosting the CopilotKit Runtime',
                'SOURCE: https://docs.copilotkit.ai/guides/self-hosting',
                'PATH: packages/core/src/core/run-handler.ts',
                'CONTENT:',
                'const handler = copilotRuntimeNextJSAppRouter({});',
            ].join('\n');

            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ body: jsonRpc({ content: [{ type: 'text', text: both }] }) }),
            );

            const results = await client.searchDocs({ query: 'self hosting' });

            expect(results[0].kind).toBe('docs');
            expect(results[0].title).toBe('Self-hosting the CopilotKit Runtime');
            expect(results[0].sourceUrl).toBe('https://docs.copilotkit.ai/guides/self-hosting');
        });

        // Isolates the header region. This block has no real SOURCE header, and a
        // line-initial `SOURCE:` inside its content. Matching headers over the
        // whole block would adopt that line as the citation.
        it('does not read a SOURCE header out of the content', async () => {
            const sourceInBody = [
                'SNIPPET 1',
                'TITLE: Configuring the runtime',
                'CONTENT:',
                '```yaml',
                'SOURCE: https://evil.example.com/not-a-real-page',
                '```',
            ].join('\n');

            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ body: jsonRpc({ content: [{ type: 'text', text: sourceInBody }] }) }),
            );

            const results = await client.searchDocs({ query: 'configuring' });

            expect(results[0].title).toBe('Configuring the runtime');
            expect(results[0].sourceUrl).toBeUndefined();
        });
    });

    describe('the AG-UI tools', () => {
        it('searchAgUiCode calls search-ag-ui-code', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ body: jsonRpc({ content: [{ type: 'text', text: CODE_SNIPPETS }] }) }),
            );

            await client.searchAgUiCode({ query: 'protocol event' });

            expect(JSON.parse(mockFetch.mock.calls[2][1].body).params.name).toBe(
                'search-ag-ui-code',
            );
        });

        it('searchAgUiDocs calls search-ag-ui-docs', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ body: jsonRpc({ content: [{ type: 'text', text: CODE_SNIPPETS }] }) }),
            );

            await client.searchAgUiDocs({ query: 'protocol event' });

            expect(JSON.parse(mockFetch.mock.calls[2][1].body).params.name).toBe(
                'search-ag-ui-docs',
            );
        });
    });

    describe('searchDocs', () => {
        it('parses the SNIPPET/TITLE/SOURCE/CONTENT text format', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({
                    body: jsonRpc(
                        {
                            content: [
                                {
                                    type: 'text',
                                    text: 'SNIPPET 1\nTITLE: CopilotKit Actions\nSOURCE: https://docs.copilotkit.ai/actions\nCONTENT:\nuseCopilotAction lets you define actions.\n\n---\n\nSNIPPET 2\nTITLE: Getting Started\nSOURCE: https://docs.copilotkit.ai/quickstart\nCONTENT:\nInstall CopilotKit with npm install.',
                                },
                            ],
                        },
                        2,
                    ),
                }),
            );

            const results = await client.searchDocs({ query: 'how to use actions' });

            expect(results).toHaveLength(2);
            expect(results[0].title).toBe('CopilotKit Actions');
            expect(results[0].sourceUrl).toBe('https://docs.copilotkit.ai/actions');
            expect(results[0].content).toContain('useCopilotAction');
            // Synthetic descending rank score (no numeric score in the text format).
            expect(results[0].score).toBeGreaterThan(results[1].score);

            // tools/call POST carries the session header + correct tool name.
            const toolCall = mockFetch.mock.calls[2];
            expect(toolCall[1].headers['Mcp-Session-Id']).toBe('sess-123');
            expect(String(toolCall[1].body)).toContain('"name":"search-docs"');
        });

        it('preserves snippet content that contains an internal --- horizontal rule', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({
                    body: jsonRpc(
                        {
                            content: [
                                {
                                    type: 'text',
                                    text: 'SNIPPET 1\nTITLE: Config\nSOURCE: https://docs.copilotkit.ai/config\nCONTENT:\nBefore the rule.\n\n---\n\nAfter the rule.',
                                },
                            ],
                        },
                        2,
                    ),
                }),
            );

            const results = await client.searchDocs({ query: 'config' });
            expect(results).toHaveLength(1);
            // Both halves survive — splitting on the "---" rule would drop the second.
            expect(results[0].content).toContain('Before the rule.');
            expect(results[0].content).toContain('After the rule.');
        });

        it('still parses the legacy JSON-array format', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({
                    body: jsonRpc(
                        {
                            content: [
                                {
                                    text: JSON.stringify([
                                        {
                                            title: 'Actions',
                                            content: 'useCopilotAction...',
                                            similarity: 0.92,
                                            url: 'https://docs.copilotkit.ai/actions',
                                        },
                                    ]),
                                },
                            ],
                        },
                        2,
                    ),
                }),
            );

            const results = await client.searchDocs({ query: 'actions' });
            expect(results).toHaveLength(1);
            expect(results[0].score).toBe(0.92);
            expect(results[0].sourceUrl).toBe('https://docs.copilotkit.ai/actions');
        });

        it('parses an SSE-framed JSON-RPC reply (data: ...)', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({
                    body:
                        'event: message\n' +
                        `data: ${jsonRpc({ content: [{ type: 'text', text: 'SNIPPET 1\nTITLE: X\nSOURCE: https://x\nCONTENT:\nhello' }] }, 2)}\n\n`,
                }),
            );

            const results = await client.searchDocs({ query: 'x' });
            expect(results).toHaveLength(1);
            expect(results[0].title).toBe('X');
        });

        it('falls back to text search when the tool call fails', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ ok: false, status: 500, statusText: 'Internal Server Error' }),
            );
            // fallback docs fetch
            mockFetch.mockResolvedValueOnce(
                mkResp({
                    body: '## Getting Started\nCopilotKit is a framework for building AI copilots.\n\n## Actions\nuseCopilotAction allows defining custom actions for the copilot.',
                }),
            );

            const results = await client.searchDocs({ query: 'actions copilot' });
            expect(results.length).toBeGreaterThan(0);
            expect(results.some((r) => r.title.includes('Actions'))).toBe(true);
        });

        it('returns empty when both MCP and fallback fail', async () => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ ok: false, status: 500, statusText: 'Error' }),
            );
            mockFetch.mockResolvedValueOnce(
                mkResp({ ok: false, status: 500, statusText: 'Error' }),
            );

            const results = await client.searchDocs({ query: 'anything' });
            expect(results).toEqual([]);
        });
    });

    describe('disconnect', () => {
        it('clears session state so the next call reconnects', async () => {
            mockConnect();
            await client.connect();
            client.disconnect();

            // Next searchDocs must re-initialize.
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ body: jsonRpc({ content: [{ text: '[]' }] }, 2) }),
            );

            await client.searchDocs({ query: 'test' });

            const initCalls = mockFetch.mock.calls.filter(([, init]) =>
                String(init.body).includes('"method":"initialize"'),
            );
            expect(initCalls).toHaveLength(2); // one per connect (before + after disconnect)
        });
    });
});

/** A minimal well-formed docs reply, shared by the relay-hygiene tests. */
const SNIPPETS = [
    'SNIPPET 1',
    'TITLE: Actions',
    'SOURCE: https://docs.copilotkit.ai/actions',
    'CONTENT:',
    'Use useCopilotAction to register a frontend action.',
].join('\n');

// The SEO-spam wave of 2026-09-10/11 got here because the relay forwards a
// GitHub issue body VERBATIM as the retrieval query: 23 spam issues became 46
// `query_log` rows of 3.3 KB marketing copy, which then ranked in Top Queries
// and seeded the gap-analysis LLM prompt. These two guards are the
// content-independent half of the fix — they bound the NEXT campaign too — so
// they are asserted at the wire, on the JSON that actually leaves the process.
describe('PathfinderClient — relay hygiene', () => {
    let client: PathfinderClient;

    beforeEach(() => {
        client = new PathfinderClient(BASE);
        mockFetch.mockReset();
    });

    afterEach(() => {
        client.disconnect();
    });

    it('identifies itself with X-Pathfinder-Source on initialize', async () => {
        mockConnect('sess-src');

        await client.connect();

        const initHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
        expect(initHeaders['X-Pathfinder-Source']).toBe(config.pathfinder.sourceTag);
    });

    // Pathfinder captures the header ONCE, when the session is minted, and closes
    // over it for the session's lifetime. A tool call that carried it would be
    // ignored, so asserting it on `initialize` specifically is the point.
    it('sends the source header on the session-minting request, not per tool call', async () => {
        mockConnect('sess-src');
        mockFetch.mockResolvedValueOnce(
            mkResp({ body: jsonRpc({ content: [{ type: 'text', text: SNIPPETS }] }) }),
        );

        await client.searchDocs({ query: 'actions' });

        const toolHeaders = mockFetch.mock.calls[2][1].headers as Record<string, string>;
        expect(toolHeaders['Mcp-Session-Id']).toBe('sess-src');
        expect(toolHeaders['X-Pathfinder-Source']).toBeUndefined();
    });

    it.each(['search-docs', 'search-code'] as const)(
        'caps an oversized %s query before it reaches the wire',
        async (tool) => {
            mockConnect();
            mockFetch.mockResolvedValueOnce(
                mkResp({ body: jsonRpc({ content: [{ type: 'text', text: SNIPPETS }] }) }),
            );

            // Shaped like the real thing: long, and with no whitespace anywhere
            // near the cut so the word-boundary pull-back cannot mask the cap.
            const blob = 'spam '.repeat(400) + 'x'.repeat(500);
            expect(blob.length).toBeGreaterThan(2000);

            if (tool === 'search-docs') {
                await client.searchDocs({ query: blob });
            } else {
                await client.searchCode({ query: blob });
            }

            const sent = JSON.parse(mockFetch.mock.calls[2][1].body);
            expect(sent.params.name).toBe(tool);
            expect(sent.params.arguments.query.length).toBeLessThanOrEqual(
                config.pathfinder.maxQueryChars,
            );
            // The HEAD is kept — that is where a real question lives.
            expect(blob.startsWith(sent.params.arguments.query)).toBe(true);
        },
    );

    it('leaves a normal-length query untouched', async () => {
        mockConnect();
        mockFetch.mockResolvedValueOnce(
            mkResp({ body: jsonRpc({ content: [{ type: 'text', text: SNIPPETS }] }) }),
        );

        await client.searchDocs({ query: 'how do I self-host the runtime?' });

        const sent = JSON.parse(mockFetch.mock.calls[2][1].body);
        expect(sent.params.arguments.query).toBe('how do I self-host the runtime?');
    });
});

describe('capQuery', () => {
    it('returns the input unchanged when it already fits', () => {
        expect(capQuery('short', 100)).toBe('short');
    });

    it('cuts at a word boundary when one is near the cut', () => {
        // Boundary at 16 of 18 — inside the trailing 15% the pull-back looks in.
        const out = capQuery('alpha beta gamma delta epsilon', 18);
        expect(out.length).toBeLessThanOrEqual(18);
        expect(out).toBe('alpha beta gamma');
    });

    // Deliberate: the pull-back only looks at the last 15%, so it can never
    // discard a meaningful share of the query to chase a boundary. Losing a few
    // characters of one token beats losing a sentence of context.
    it('accepts a mid-token cut rather than reaching far back for a boundary', () => {
        expect(capQuery('alpha beta gamma delta epsilon', 20)).toBe('alpha beta gamma del');
    });

    // A single unbroken token has no boundary to fall back to; a hard cut is
    // still better than shipping the whole blob.
    it('hard-cuts when there is no late whitespace to fall back to', () => {
        expect(capQuery('x'.repeat(50), 10)).toBe('x'.repeat(10));
    });

    it('treats a non-positive cap as "no cap" rather than emptying the query', () => {
        expect(capQuery('anything', 0)).toBe('anything');
    });
});

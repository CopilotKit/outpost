import { afterEach, describe, expect, it, vi } from 'vitest';
import { PathfinderClient } from './pathfinder.js';

function mockServer(result: unknown) {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ result: {} }), {
            headers: { 'mcp-session-id': 'test-session' },
        }),
    );
    fetchMock.mockResolvedValueOnce(new Response(''));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result })));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe.each([
    ['searchDocs', 'search-docs'],
    ['searchCode', 'search-code'],
    ['searchAgUiDocs', 'search-ag-ui-docs'],
    ['searchAgUiCode', 'search-ag-ui-code'],
] as const)('%s version filtering', (method, tool) => {
    it.each(['v1', 'v2', undefined] as const)(
        'preserves the requested version %s in the JSON-RPC arguments',
        async (version) => {
            const fetchMock = mockServer({ content: [{ type: 'text', text: '[]' }] });
            const client = new PathfinderClient('https://mcp.example.test');
            await client[method]({ query: 'subagents', limit: 3, minScore: 0.6, version });

            const request = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
            expect(request).toMatchObject({
                jsonrpc: '2.0',
                method: 'tools/call',
                params: {
                    name: tool,
                    arguments: { query: 'subagents', limit: 3, min_score: 0.6 },
                },
            });
            if (version === undefined) {
                expect(request.params.arguments).not.toHaveProperty('version');
            } else {
                expect(request.params.arguments).toHaveProperty('version', version);
            }
        },
    );
});

describe('agent evidence retrieval', () => {
    const validCodeSnippet = [
        'SNIPPET 1',
        'REPOSITORY: https://github.com/CopilotKit/CopilotKit.git',
        'PATH: packages/core/src/core/run-handler.ts',
        'CONTENT:',
        '1114 |     const agent = this._internal.getAgent(resolvedAgentId);',
    ].join('\n');

    it('sends the version filter to the actual MCP tool', async () => {
        const fetchMock = mockServer({ content: [{ type: 'text', text: '[]' }] });
        const client = new PathfinderClient('https://mcp.example.test');
        await client.searchEvidence('search-code', { query: 'subagents', version: 'v2' });
        expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
            params: { name: 'search-code', arguments: { query: 'subagents', version: 'v2' } },
        });
    });

    it('recognizes Pathfinder explicit no_results envelopes', async () => {
        mockServer({
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({ results: [], reason: 'no_results', domain: 'docs' }),
                },
            ],
        });
        await expect(
            new PathfinderClient('https://mcp.example.test').searchEvidence('search-docs', {
                query: 'tools',
            }),
        ).resolves.toEqual([]);
    });

    it('recognizes Pathfinder explicit no_results envelopes for code evidence', async () => {
        mockServer({
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({ results: [], reason: 'no_results', domain: 'code' }),
                },
            ],
        });
        await expect(
            new PathfinderClient('https://mcp.example.test').searchEvidence('search-code', {
                query: 'tools',
            }),
        ).resolves.toEqual([]);
    });

    it('returns strict code evidence when the hit has a usable citation URL', async () => {
        mockServer({ content: [{ type: 'text', text: validCodeSnippet }] });
        await expect(
            new PathfinderClient('https://mcp.example.test').searchEvidence('search-code', {
                query: 'subagents',
            }),
        ).resolves.toMatchObject([
            {
                kind: 'code',
                title: 'packages/core/src/core/run-handler.ts',
                sourceUrl:
                    'https://github.com/CopilotKit/CopilotKit/blob/main/packages/core/src/core/run-handler.ts',
            },
        ]);
    });

    it.each([
        [
            'missing repository',
            ['SNIPPET 1', 'PATH: packages/core/src/core/run-handler.ts', 'CONTENT:', 'run();'].join(
                '\n',
            ),
        ],
        [
            'unusable repository',
            [
                'SNIPPET 1',
                'REPOSITORY: git@github.com:CopilotKit/CopilotKit.git',
                'PATH: packages/core/src/core/run-handler.ts',
                'CONTENT:',
                'run();',
            ].join('\n'),
        ],
    ])('rejects strict code evidence with %s', async (_name, text) => {
        mockServer({ content: [{ type: 'text', text }] });
        await expect(
            new PathfinderClient('https://mcp.example.test').searchEvidence('search-code', {
                query: 'subagents',
            }),
        ).rejects.toThrow('malformed uncitable code evidence');
    });

    it('distinguishes an MCP tool error from no results', async () => {
        mockServer({ isError: true, content: [{ type: 'text', text: 'Index unavailable' }] });
        const client = new PathfinderClient('https://mcp.example.test');
        await expect(client.searchEvidence('search-docs', { query: 'tools' })).rejects.toThrow(
            'search-docs',
        );
    });

    it.each([{}, { content: [{ type: 'text', text: 'unparseable upstream output' }] }])(
        'rejects malformed evidence payloads instead of returning no results',
        async (payload) => {
            mockServer(payload);
            await expect(
                new PathfinderClient('https://mcp.example.test').searchEvidence('search-docs', {
                    query: 'tools',
                }),
            ).rejects.toThrow('malformed');
        },
    );

    it('stops connection setup when cancellation happens during initialize', async () => {
        const controller = new AbortController();
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
            const method = JSON.parse(String(init?.body)).method;
            if (method === 'initialize') {
                if (fetchMock.mock.calls.length === 1) {
                    controller.abort(new Error('Run cancelled during initialize'));
                    return new Response(JSON.stringify({ result: {} }), {
                        headers: { 'mcp-session-id': 'abandoned-session' },
                    });
                }
                return new Response(JSON.stringify({ result: {} }), {
                    headers: { 'mcp-session-id': 'fresh-session' },
                });
            }
            if (method === 'notifications/initialized') {
                return new Response('');
            }
            return new Response(
                JSON.stringify({ result: { content: [{ type: 'text', text: '[]' }] } }),
            );
        });
        vi.stubGlobal('fetch', fetchMock);
        const client = new PathfinderClient('https://mcp.example.test');
        await expect(
            client.searchEvidence('search-docs', { query: 'tools' }, controller.signal),
        ).rejects.toThrow('Run cancelled during initialize');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);

        await expect(client.searchEvidence('search-docs', { query: 'tools' })).resolves.toEqual([]);

        const requests = fetchMock.mock.calls.map(([, init]) => ({
            headers: init?.headers as Record<string, string>,
            method: JSON.parse(String(init?.body)).method as string,
        }));
        expect(requests.map((request) => request.method)).toEqual([
            'initialize',
            'initialize',
            'notifications/initialized',
            'tools/call',
        ]);
        expect(requests[1].headers).not.toHaveProperty('Mcp-Session-Id');
        expect(requests[3].headers).toHaveProperty('Mcp-Session-Id', 'fresh-session');
    });

    it('reuses a completed session for sequential strict evidence searches', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
            const method = JSON.parse(String(init?.body)).method;
            if (method === 'initialize') {
                return new Response(JSON.stringify({ result: {} }), {
                    headers: { 'mcp-session-id': 'test-session' },
                });
            }
            if (method === 'notifications/initialized') {
                return new Response('');
            }
            return new Response(
                JSON.stringify({ result: { content: [{ type: 'text', text: '[]' }] } }),
            );
        });
        vi.stubGlobal('fetch', fetchMock);
        const client = new PathfinderClient('https://mcp.example.test');

        await expect(client.searchEvidence('search-docs', { query: 'tools' })).resolves.toEqual([]);
        await expect(client.searchEvidence('search-docs', { query: 'tools' })).resolves.toEqual([]);

        const requests = fetchMock.mock.calls.map(([, init]) => ({
            headers: init?.headers as Record<string, string>,
            method: JSON.parse(String(init?.body)).method as string,
        }));
        expect(requests.map((request) => request.method)).toEqual([
            'initialize',
            'notifications/initialized',
            'tools/call',
            'tools/call',
        ]);
        expect(requests[3].headers).toHaveProperty('Mcp-Session-Id', 'test-session');
    });

    it('rejects a cancelled run before starting another network request', async () => {
        const fetchMock = mockServer({ content: [] });
        const client = new PathfinderClient('https://mcp.example.test');
        const controller = new AbortController();
        controller.abort(new Error('Run cancelled'));
        await expect(
            client.searchEvidence('search-docs', { query: 'tools' }, controller.signal),
        ).rejects.toThrow('Run cancelled');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

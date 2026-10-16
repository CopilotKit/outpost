import { afterEach, describe, expect, it, vi } from 'vitest';
import { PathfinderClient } from './pathfinder.js';
import { validateSupportReply } from './support-reply.js';

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

const searches = [
    ['searchDocs', 'search-docs'],
    ['searchCode', 'search-code'],
    ['searchAgUiDocs', 'search-ag-ui-docs'],
    ['searchAgUiCode', 'search-ag-ui-code'],
] as const;

afterEach(() => vi.unstubAllGlobals());

describe.each(searches)('%s strict legacy JSON evidence', (method, tool) => {
    const content = 'useCopilotAction registers frontend actions.';
    const sourceUrl = 'https://docs.copilotkit.ai/actions';
    const valid = { title: 'Actions', content, score: 0.9, sourceUrl };

    function retrieve(entries: unknown[]) {
        mockServer({ content: [{ type: 'text', text: JSON.stringify(entries) }] });
        return new PathfinderClient('https://mcp.example.test').searchEvidence(tool, {
            query: 'actions',
        });
    }

    it.each([
        ['object content', { content: { text: content }, score: 0.9 }],
        ['boolean snippet', { snippet: true, score: 0.9 }],
        ['numeric text', { text: 42, score: 0.9 }],
        ['blank content', { content: ' \n ', score: 0.9 }],
        ['missing content', { score: 0.9 }],
        ['missing score', { content }],
        ['null score', { content, score: null }],
        ['numeric string similarity', { content, similarity: '0.9' }],
        ['boolean score', { content, score: true }],
        ['array relevance', { content, relevance: [0.9] }],
        ['invalid preferred content', { content: false, snippet: content, score: 0.9 }],
        ['invalid preferred score', { content, similarity: 'bad', score: 0.9 }],
    ])('rejects %s instead of coercing it into evidence', async (_name, fields) => {
        await expect(retrieve([{ title: 'Actions', sourceUrl, ...fields }])).rejects.toThrow(
            'malformed search evidence',
        );
    });

    it.each([
        ['content/similarity', { content, similarity: 0.9 }, 0.9],
        ['snippet/score', { snippet: content, score: 0.9 }, 0.9],
        ['text/relevance', { text: content, relevance: 0.9 }, 0.9],
        [
            'nullish alias fallback and zero',
            { content: null, snippet: content, similarity: null, score: 0 },
            0,
        ],
    ])('preserves valid %s fields', async (_name, fields, score) => {
        await expect(retrieve([{ title: 'Actions', sourceUrl, ...fields }])).resolves.toEqual([
            { title: 'Actions', content, score, sourceUrl },
        ]);
    });

    it('rejects the whole result when one entry has malformed fields', async () => {
        await expect(retrieve([valid, { ...valid, content: { text: content } }])).rejects.toThrow(
            'malformed search evidence',
        );
    });

    it.each([
        ['JSON array', { content: [{ type: 'text', text: '[]' }] }],
        [
            'no_results envelope',
            { content: [{ type: 'text', text: '{"results":[],"reason":"no_results"}' }] },
        ],
        ['empty MCP success', { content: [] }],
    ])('preserves explicit absence via %s', async (_name, payload) => {
        mockServer(payload);
        await expect(
            new PathfinderClient('https://mcp.example.test').searchEvidence(tool, {
                query: 'actions',
            }),
        ).resolves.toEqual([]);
    });

    it('keeps the public legacy wrapper tolerant', async () => {
        mockServer({
            content: [
                { type: 'text', text: JSON.stringify([{ ...valid, content: true, score: '0.9' }]) },
            ],
        });
        await expect(
            new PathfinderClient('https://mcp.example.test')[method]({ query: 'actions' }),
        ).resolves.toEqual([{ ...valid, content: 'true' }]);
    });
});

describe.each(searches)('%s version filtering', (method, tool) => {
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

    it.each(['search-code', 'search-ag-ui-code'] as const)(
        'rejects legacy JSON %s evidence without a usable citation URL',
        async (tool) => {
            mockServer({
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify([
                            {
                                title: 'packages/foo.ts',
                                content: 'export const x = 1;',
                                score: 0.9,
                            },
                        ]),
                    },
                ],
            });

            await expect(
                new PathfinderClient('https://mcp.example.test').searchEvidence(tool, {
                    query: 'subagents',
                }),
            ).rejects.toThrow('malformed uncitable code evidence');
        },
    );

    it('keeps legacy JSON docs evidence accepted when it has usable content and score', async () => {
        mockServer({
            content: [
                {
                    type: 'text',
                    text: JSON.stringify([
                        {
                            title: 'Actions',
                            content: 'useCopilotAction registers frontend actions.',
                            score: 0.9,
                        },
                    ]),
                },
            ],
        });

        await expect(
            new PathfinderClient('https://mcp.example.test').searchEvidence('search-docs', {
                query: 'actions',
            }),
        ).resolves.toMatchObject([
            {
                title: 'Actions',
                content: 'useCopilotAction registers frontend actions.',
                score: 0.9,
            },
        ]);
    });

    it('normalizes .git/ repository suffixes before strict code evidence validation', async () => {
        const gitSlashCodeSnippet = validCodeSnippet.replace(
            'https://github.com/CopilotKit/CopilotKit.git',
            'https://github.com/CopilotKit/CopilotKit.git/',
        );
        mockServer({ content: [{ type: 'text', text: gitSlashCodeSnippet }] });

        await expect(
            new PathfinderClient('https://mcp.example.test').searchEvidence('search-code', {
                query: 'subagents',
            }),
        ).resolves.toMatchObject([
            {
                kind: 'code',
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

describe.each(['search-code', 'search-ag-ui-code'] as const)('%s citation contract', (tool) => {
    const repository = 'https://github.com/CopilotKit/CopilotKit';
    const path = 'packages/core/src/core/run-handler.ts';
    const blob = `${repository}/blob/main/${path}`;
    const quote = 'const agent = this._internal.getAgent(resolvedAgentId);';
    const cases: Array<{
        name: string;
        url?: string;
        repository?: string;
        path?: string;
        expectedBlob?: string;
    }> = [
        { name: 'missing citation' },
        { name: 'blank citation', url: ' ', repository: ' ' },
        { name: 'malformed citation', url: 'not-a-url', repository: 'not-a-url' },
        { name: 'relative citation', url: '/file.ts', repository: '/CopilotKit/CopilotKit' },
        { name: 'missing host', url: 'https://', repository: 'https://' },
        {
            name: 'FTP citation',
            url: 'ftp://example.com/file.ts',
            repository: 'ftp://github.com/CopilotKit/CopilotKit',
        },
        {
            name: 'embedded credentials',
            url: 'https://user:pass@example.com/file.ts',
            repository: 'https://user:pass@github.com/CopilotKit/CopilotKit',
        },
        {
            name: 'raw space in path',
            url: `${repository}/blob/main/My File.ts`,
            repository,
            path: 'My File.ts',
        },
        {
            name: 'raw tab in path',
            url: `${repository}/blob/main/My\tFile.ts`,
            repository,
            path: 'My\tFile.ts',
        },
        {
            name: 'invalid URL delimiter',
            url: 'https://example.com/"file.ts',
            repository: `${repository}/"invalid`,
        },
        {
            name: 'HTTP citation',
            url: 'http://source.example.test/file.ts',
            repository: repository.replace('https:', 'http:'),
            expectedBlob: blob.replace('https:', 'http:'),
        },
        {
            name: 'HTTPS citation',
            url: 'https://source.example.test/file.ts',
            repository,
            expectedBlob: blob,
        },
        {
            name: 'normalized repository and path metadata',
            url: blob,
            repository: `${repository}.git/`,
            path: `/${path}`,
            expectedBlob: blob,
        },
        {
            name: 'encoded path',
            url: `${repository}/blob/main/My%20File.ts`,
            repository,
            path: 'My%20File.ts',
            expectedBlob: `${repository}/blob/main/My%20File.ts`,
        },
    ];

    describe.each(['legacy sourceUrl', 'legacy url', 'SNIPPET repository/path', 'SNIPPET SOURCE'])(
        '%s representation',
        (format) => {
            it.each(cases)('$name', async (citation) => {
                const citationPath = citation.path ?? path;
                const text = format.startsWith('legacy')
                    ? JSON.stringify([
                          {
                              title: citationPath,
                              content: quote,
                              score: 0.9,
                              [format === 'legacy url' ? 'url' : 'sourceUrl']: citation.url,
                              // Legacy results deliberately omit kind.
                          },
                      ])
                    : [
                          'SNIPPET 1',
                          ...(format === 'SNIPPET SOURCE'
                              ? [
                                    `TITLE: ${citationPath}`,
                                    ...(citation.url === undefined
                                        ? []
                                        : [`SOURCE: ${citation.url}`]),
                                ]
                              : citation.repository === undefined
                                ? []
                                : [`REPOSITORY: ${citation.repository}`]),
                          `PATH: ${citationPath}`,
                          'CONTENT:',
                          `1114 | ${quote}`,
                      ].join('\n');
                const fetchMock = mockServer({ content: [{ type: 'text', text }] });
                const retrieval = new PathfinderClient('https://mcp.example.test').searchEvidence(
                    tool,
                    { query: 'subagents' },
                );

                if (!citation.expectedBlob) {
                    await expect(retrieval).rejects.toThrow(
                        `Pathfinder ${tool} returned malformed uncitable code evidence`,
                    );
                } else {
                    const results = await retrieval;
                    const expectedUrl =
                        format === 'SNIPPET repository/path' ? citation.expectedBlob : citation.url;
                    expect(results).toHaveLength(1);
                    expect(results[0].sourceUrl).toBe(expectedUrl);
                    const reply = {
                        decision: 'answer',
                        summary: 'The handler retrieves the configured agent.',
                        details: `[Source](<${expectedUrl}>)`,
                        apiVersion: 'unknown',
                        appliesTo: '',
                        evidence: [{ sourceUrl: results[0].sourceUrl, quote }],
                        handoffReason: '',
                    };
                    expect(validateSupportReply(reply, results)).toEqual(reply);
                }
                expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
                    method: 'tools/call',
                    params: { name: tool },
                });
            });
        },
    );

    it('preserves explicit no_results success', async () => {
        mockServer({
            content: [
                { type: 'text', text: JSON.stringify({ results: [], reason: 'no_results' }) },
            ],
        });
        await expect(
            new PathfinderClient('https://mcp.example.test').searchEvidence(tool, {
                query: 'tools',
            }),
        ).resolves.toEqual([]);
    });
});

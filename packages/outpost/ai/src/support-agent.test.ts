import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAimock } from './test-utils/aimock.js';
import {
    SupportAgent,
    InvalidSupportReplyError,
    InvestigationBudgetError,
} from './support-agent.js';
import { validateSupportReply, type SupportReply } from './support-reply.js';
import type { PathfinderClient } from './pathfinder.js';

const source = {
    title: 'Tools',
    content: 'Register frontend tools with useFrontendTool.',
    sourceUrl: 'https://docs.copilotkit.ai/tools',
    score: 0.9,
};
const deprecatedSource = {
    ...source,
    title: 'Legacy tools',
    content: 'Register frontend actions with useCopilotAction.',
    sourceUrl: 'https://docs.copilotkit.ai/v1-deprecated/tools',
};
const deprecatedTitleSource = {
    ...deprecatedSource,
    title: 'V1-DEPRECATED tools',
    sourceUrl: 'https://docs.copilotkit.ai/legacy/tools',
};
const reply: SupportReply = {
    decision: 'answer',
    summary: 'Register this action with `useFrontendTool`.',
    details: 'Use the tool registration hook in your client component.',
    apiVersion: 'v2',
    appliesTo: 'CopilotKit v2',
    evidence: [{ sourceUrl: source.sourceUrl, quote: source.content }],
    handoffReason: '',
};

describe('OpenAI support agent', () => {
    const mock = useAimock();
    afterEach(() => vi.unstubAllGlobals());
    function setup() {
        const searchEvidence = vi
            .fn<PathfinderClient['searchEvidence']>()
            .mockResolvedValue([source]);
        const agent = new SupportAgent({
            apiKey: 'test-key',
            baseURL: mock().url,
            tracingDisabled: true,
            pathfinder: { searchEvidence },
        });
        return { agent, searchEvidence };
    }
    function toolRoundtrip(output: unknown = reply, version: SupportReply['apiVersion'] = 'v2') {
        mock().llm.on(
            { predicate: (req) => req.messages.some((m) => m.role === 'tool') },
            { content: JSON.stringify(output) },
        );
        mock().llm.onMessage(/./, {
            toolCalls: [
                {
                    id: 'call_search',
                    name: 'search_evidence',
                    arguments: {
                        query: 'frontend tools',
                        corpus: 'copilotkit',
                        kind: 'docs',
                        version,
                    },
                },
            ],
        });
    }
    it('executes the SDK tool loop and validates the final output against actual sources', async () => {
        toolRoundtrip();
        const { agent, searchEvidence } = setup();
        const result = await agent.investigate({
            question: 'How do I register frontend tools?',
            source: 'github',
        });
        expect(searchEvidence).toHaveBeenCalledWith(
            'search-docs',
            expect.objectContaining({ query: 'frontend tools', version: 'v2' }),
            expect.any(AbortSignal),
        );
        expect(result.reply).toEqual(reply);
        expect(result.sources).toEqual([source]);
        expect(mock().llm.getRequests()).toHaveLength(2);
        expect(mock().llm.getLastRequest()?.body?.model).toBe('gpt-5.6-luna');
    });
    it.each(['not JSON', '{}'])(
        'routes SDK-level malformed structured output: %s',
        async (content) => {
            mock().llm.onMessage(/./, { content });
            await expect(
                setup().agent.investigate({ question: 'Tools?', source: 'github' }),
            ).rejects.toBeInstanceOf(InvalidSupportReplyError);
        },
    );
    it('routes a run that exhausts its turns without output', async () => {
        mock().llm.onMessage(/./, { content: '' });
        await expect(
            setup().agent.investigate({ question: 'Tools?', source: 'github' }),
        ).rejects.toBeInstanceOf(InvestigationBudgetError);
    });
    it('resolves a source ref to a pinned commit and reads only the allowlisted repository', async () => {
        const sha = 'a'.repeat(40);
        const url = `https://github.com/CopilotKit/CopilotKit/blob/${sha}/packages/tools.ts`;
        const output = { ...reply, evidence: [{ sourceUrl: url, quote: source.content }] };
        const realFetch = globalThis.fetch;
        const githubRequests: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>(async (input, init) => {
                const requestUrl = input instanceof Request ? input.url : String(input);
                if (!requestUrl.startsWith('https://api.github.com/'))
                    return realFetch(input, init);
                githubRequests.push(requestUrl);
                return new Response(
                    JSON.stringify(
                        requestUrl.includes('/commits/')
                            ? { sha }
                            : {
                                  encoding: 'base64',
                                  content: Buffer.from(source.content).toString('base64'),
                                  size: source.content.length,
                              },
                    ),
                );
            }),
        );
        mock().llm.on(
            { predicate: (req) => req.messages.some((m) => m.role === 'tool') },
            { content: JSON.stringify(output) },
        );
        mock().llm.onMessage(/./, {
            toolCalls: [
                {
                    id: 'call_source',
                    name: 'read_source',
                    arguments: {
                        repository: 'CopilotKit/CopilotKit',
                        path: 'packages/tools.ts',
                        ref: 'v2.0.0',
                    },
                },
            ],
        });
        const result = await setup().agent.investigate({ question: 'Tools?', source: 'github' });
        expect(result.sources[0].sourceUrl).toBe(url);
        expect(githubRequests).toEqual([
            'https://api.github.com/repos/CopilotKit/CopilotKit/commits/v2.0.0',
            `https://api.github.com/repos/CopilotKit/CopilotKit/contents/packages/tools.ts?ref=${sha}`,
        ]);
    });
    it.each([
        {
            path: 'docs/My Guide.md',
            encodedPath: 'docs/My%20Guide.md',
        },
        {
            path: 'docs/100% ready (setup).md',
            encodedPath: 'docs/100%25%20ready%20(setup).md',
        },
    ])(
        'encodes read_source path segments for contents fetches and remembered blob citations: $path',
        async ({ path, encodedPath }) => {
            const sha = 'a'.repeat(40);
            const url = `https://github.com/CopilotKit/CopilotKit/blob/${sha}/${encodedPath}`;
            const output = { ...reply, evidence: [{ sourceUrl: url, quote: source.content }] };
            const realFetch = globalThis.fetch;
            const githubRequests: string[] = [];
            vi.stubGlobal(
                'fetch',
                vi.fn<typeof fetch>(async (input, init) => {
                    const requestUrl = input instanceof Request ? input.url : String(input);
                    if (!requestUrl.startsWith('https://api.github.com/'))
                        return realFetch(input, init);
                    githubRequests.push(requestUrl);
                    return new Response(
                        JSON.stringify(
                            requestUrl.includes('/commits/')
                                ? { sha }
                                : {
                                      encoding: 'base64',
                                      content: Buffer.from(source.content).toString('base64'),
                                      size: source.content.length,
                                  },
                        ),
                    );
                }),
            );
            mock().llm.on(
                { predicate: (req) => req.messages.some((m) => m.role === 'tool') },
                { content: JSON.stringify(output) },
            );
            mock().llm.onMessage(/./, {
                toolCalls: [
                    {
                        id: 'call_source',
                        name: 'read_source',
                        arguments: {
                            repository: 'CopilotKit/CopilotKit',
                            path,
                            ref: 'v2.0.0',
                        },
                    },
                ],
            });
            const result = await setup().agent.investigate({
                question: 'Tools?',
                source: 'github',
            });
            expect(result.sources[0].sourceUrl).toBe(url);
            expect(result.reply).toEqual(validateSupportReply(output, result.sources));
            expect(githubRequests).toEqual([
                'https://api.github.com/repos/CopilotKit/CopilotKit/commits/v2.0.0',
                `https://api.github.com/repos/CopilotKit/CopilotKit/contents/${encodedPath}?ref=${sha}`,
            ]);
        },
    );
    it('reads explicit release evidence without inferring a release from main', async () => {
        const url = 'https://github.com/CopilotKit/CopilotKit/releases/tag/v2.0.0';
        const realFetch = globalThis.fetch;
        const githubRequests: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>(async (input, init) => {
                const requestUrl = input instanceof Request ? input.url : String(input);
                if (!requestUrl.startsWith('https://api.github.com/'))
                    return realFetch(input, init);
                githubRequests.push(requestUrl);
                return new Response(
                    JSON.stringify({
                        tag_name: 'v2.0.0',
                        html_url: url,
                        body: source.content,
                        published_at: '2026-01-01',
                        draft: false,
                        prerelease: false,
                    }),
                );
            }),
        );
        mock().llm.on(
            { predicate: (req) => req.messages.some((m) => m.role === 'tool') },
            {
                content: JSON.stringify({
                    ...reply,
                    evidence: [{ sourceUrl: url, quote: source.content }],
                }),
            },
        );
        mock().llm.onMessage(/./, {
            toolCalls: [
                {
                    id: 'call_release',
                    name: 'read_release',
                    arguments: { repository: 'CopilotKit/CopilotKit', tag: 'v2.0.0' },
                },
            ],
        });
        const result = await setup().agent.investigate({ question: 'Tools?', source: 'github' });
        expect(result.sources[0].sourceUrl).toBe(url);
        expect(githubRequests).toEqual([
            'https://api.github.com/repos/CopilotKit/CopilotKit/releases/tags/v2.0.0',
        ]);
    });
    it('lets the investigator route a missing release without treating it as a transport outage', async () => {
        const realFetch = globalThis.fetch;
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>(async (input, init) => {
                const url = input instanceof Request ? input.url : String(input);
                return url.startsWith('https://api.github.com/')
                    ? new Response('', { status: 404 })
                    : realFetch(input, init);
            }),
        );
        const route = {
            ...reply,
            decision: 'route',
            summary: 'This needs a version check.',
            details: '',
            evidence: [],
            handoffReason: 'Requested release tag was not found',
        };
        mock().llm.on(
            { predicate: (req) => req.messages.some((m) => m.role === 'tool') },
            { content: JSON.stringify(route) },
        );
        mock().llm.onMessage(/./, {
            toolCalls: [
                {
                    id: 'call_release',
                    name: 'read_release',
                    arguments: { repository: 'CopilotKit/CopilotKit', tag: 'v9.9.9' },
                },
            ],
        });
        const result = await setup().agent.investigate({ question: 'Version?', source: 'github' });
        expect(result.reply.decision).toBe('route');
        expect(result.sources).toEqual([]);
        expect(JSON.stringify(mock().llm.getLastRequest()?.body)).toContain('not_found');
    });
    it('rejects source paths escaping the repository before making a GitHub request', async () => {
        mock().llm.onMessage(/./, {
            toolCalls: [
                {
                    id: 'call_source',
                    name: 'read_source',
                    arguments: {
                        repository: 'CopilotKit/CopilotKit',
                        path: '../secret',
                        ref: 'main',
                    },
                },
            ],
        });
        await expect(
            setup().agent.investigate({ question: 'Tools?', source: 'github' }),
        ).rejects.toBeInstanceOf(InvalidSupportReplyError);
    });
    it.each([
        { description: 'empty', initialResults: [] },
        { description: 'deprecated-only', initialResults: [deprecatedSource] },
        { description: 'uppercase deprecated-only', initialResults: [deprecatedTitleSource] },
    ])(
        'broadens $description version results and labels the usable fallback evidence',
        async ({ initialResults }) => {
            toolRoundtrip();
            const { agent, searchEvidence } = setup();
            searchEvidence
                .mockResolvedValueOnce(initialResults)
                .mockResolvedValueOnce([deprecatedSource, deprecatedTitleSource, source]);
            const result = await agent.investigate({ question: 'Tools in v2?', source: 'github' });
            expect(searchEvidence).toHaveBeenCalledTimes(2);
            expect(searchEvidence).toHaveBeenNthCalledWith(
                1,
                'search-docs',
                { query: 'frontend tools', limit: 4, version: 'v2' },
                expect.any(AbortSignal),
            );
            expect(searchEvidence).toHaveBeenNthCalledWith(
                2,
                'search-docs',
                { query: 'frontend tools', limit: 4 },
                searchEvidence.mock.calls[0][2],
            );
            expect(result.reply).toEqual(reply);
            expect(result.sources).toEqual([source]);
            const modelInput = JSON.stringify(mock().llm.getLastRequest()?.body);
            expect(modelInput).toContain('unfiltered_fallback');
            expect(modelInput).not.toContain(deprecatedSource.sourceUrl);
            expect(modelInput).not.toContain(deprecatedTitleSource.sourceUrl);
            expect(mock().llm.getRequests()).toHaveLength(2);
        },
    );
    it('keeps the requested scope when mixed version results include usable evidence', async () => {
        toolRoundtrip();
        const { agent, searchEvidence } = setup();
        searchEvidence.mockResolvedValueOnce([deprecatedSource, source]);
        const result = await agent.investigate({ question: 'Tools in v2?', source: 'github' });
        expect(searchEvidence).toHaveBeenCalledTimes(1);
        expect(result.sources).toEqual([source]);
        const modelInput = JSON.stringify(mock().llm.getLastRequest()?.body);
        expect(modelInput).toContain('requested_version');
        expect(modelInput).not.toContain(deprecatedSource.sourceUrl);
    });
    it.each(['v1', 'unknown'] as const)(
        'preserves deprecated evidence for a %s search without broadening',
        async (version) => {
            toolRoundtrip(
                {
                    ...reply,
                    apiVersion: version,
                    evidence: [
                        { sourceUrl: deprecatedSource.sourceUrl, quote: deprecatedSource.content },
                    ],
                },
                version,
            );
            const { agent, searchEvidence } = setup();
            searchEvidence.mockResolvedValueOnce([deprecatedSource]);
            const result = await agent.investigate({ question: 'Legacy tools?', source: 'github' });
            expect(searchEvidence).toHaveBeenCalledTimes(1);
            expect(searchEvidence.mock.calls[0][1]).toEqual({
                query: 'frontend tools',
                limit: 4,
                ...(version === 'unknown' ? {} : { version }),
            });
            expect(result.sources).toEqual([deprecatedSource]);
            expect(JSON.stringify(mock().llm.getLastRequest()?.body)).toContain(
                version === 'unknown' ? 'unfiltered' : 'requested_version',
            );
        },
    );
    it('propagates a fallback retrieval failure after filtering deprecated evidence', async () => {
        toolRoundtrip();
        const { agent, searchEvidence } = setup();
        searchEvidence
            .mockResolvedValueOnce([deprecatedSource])
            .mockRejectedValueOnce(new Error('Pathfinder fallback unavailable'));
        await expect(
            agent.investigate({ question: 'Tools in v2?', source: 'github' }),
        ).rejects.toThrow('Pathfinder fallback unavailable');
        expect(searchEvidence).toHaveBeenCalledTimes(2);
    });
    it('rejects a fabricated evidence quote', async () => {
        toolRoundtrip({
            ...reply,
            evidence: [{ sourceUrl: source.sourceUrl, quote: 'This feature is not supported.' }],
        });
        await expect(
            setup().agent.investigate({ question: 'Tools?', source: 'github' }),
        ).rejects.toThrow('evidence');
    });
    it('rejects unsourced output even when the model skips investigation', async () => {
        mock().llm.onMessage(/./, { content: JSON.stringify(reply) });
        await expect(
            setup().agent.investigate({ question: 'Tools?', source: 'github' }),
        ).rejects.toThrow('evidence');
    });
    it('does not disguise a retrieval failure as a valid answer', async () => {
        toolRoundtrip();
        const { agent, searchEvidence } = setup();
        searchEvidence.mockRejectedValue(new Error('Pathfinder unavailable'));
        await expect(agent.investigate({ question: 'Tools?', source: 'github' })).rejects.toThrow(
            'Pathfinder unavailable',
        );
    });
    it('rejects a model that calls a tool after tools have been removed', async () => {
        for (let i = 0; i < 8; i++)
            mock().llm.on(
                { userMessage: /./, sequenceIndex: i },
                {
                    toolCalls: [
                        {
                            id: `call_${i}`,
                            name: 'search_evidence',
                            arguments: {
                                query: 'tools',
                                corpus: 'copilotkit',
                                kind: 'docs',
                                version: 'unknown',
                            },
                        },
                    ],
                },
            );
        const { agent, searchEvidence } = setup();
        await expect(agent.investigate({ question: 'Tools?', source: 'github' })).rejects.toThrow(
            InvalidSupportReplyError,
        );
        expect(searchEvidence).toHaveBeenCalledTimes(6);
    });
    it('removes tools after six calls so the final turn can use the collected evidence', async () => {
        mock().llm.on({ userMessage: /./, sequenceIndex: 6 }, { content: JSON.stringify(reply) });
        for (let i = 0; i < 6; i++) {
            mock().llm.on(
                { userMessage: /./, sequenceIndex: i },
                {
                    toolCalls: [
                        {
                            id: `call_budget_${i}`,
                            name: 'search_evidence',
                            arguments: {
                                query: 'tools',
                                corpus: 'copilotkit',
                                kind: 'docs',
                                version: 'unknown',
                            },
                        },
                    ],
                },
            );
        }
        const { agent, searchEvidence } = setup();
        const result = await agent.investigate({ question: 'Tools?', source: 'github' });
        expect(result.reply).toEqual(reply);
        expect(searchEvidence).toHaveBeenCalledTimes(6);
        expect(mock().llm.getRequests()).toHaveLength(7);
        expect(mock().llm.getLastRequest()?.body?.tools ?? []).toEqual([]);
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAimock } from './test-utils/aimock.js';
import {
    SupportAgent,
    InvalidSupportReplyError,
    InvestigationBudgetError,
} from './support-agent.js';
import { validateSupportReply, type SupportReply } from './support-reply.js';
import {
    githubEvidenceAuthFromEnv,
    type InstallationTokenFactory,
} from './github-evidence-auth.js';
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
const routeReply = {
    ...reply,
    decision: 'route',
    summary: 'Source evidence was unavailable, so a maintainer should confirm this.',
    details: '',
    evidence: [],
    handoffReason: 'Requested GitHub evidence was unavailable during the investigation',
};
const PINNED_SHA = 'a'.repeat(40);
const SOURCE_PATH = 'packages/tools.ts';
const BLOB_URL = `https://github.com/CopilotKit/CopilotKit/blob/${PINNED_SHA}/${SOURCE_PATH}`;
const groundedReply = { ...reply, evidence: [{ sourceUrl: BLOB_URL, quote: source.content }] };

/** Routes only api.github.com through the stub so the aimock HTTP server stays reachable. */
function stubGitHub(respond: (url: string) => Response): string[] {
    const realFetch = globalThis.fetch;
    const requests: string[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
            requests.push(url);
            return respond(url);
        }),
    );
    return requests;
}

function okSourceFile(url: string): Response {
    return new Response(
        JSON.stringify(
            url.includes('/commits/')
                ? { sha: PINNED_SHA }
                : {
                      encoding: 'base64',
                      content: Buffer.from(source.content).toString('base64'),
                      size: source.content.length,
                  },
        ),
    );
}

describe('OpenAI support agent', () => {
    const mock = useAimock();
    // The agent now reads App credentials from the environment by default. Clear them so a
    // developer's exported GITHUB_* does not change which auth path these tests exercise.
    beforeEach(() => {
        for (const name of ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID'])
            vi.stubEnv(name, undefined as unknown as string);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });
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
    type ScriptedTurn =
        | { tool: 'read_source'; path: string; ref?: string }
        | { tool: 'read_release'; tag: string }
        | { output: unknown };
    /** One scripted response per run turn, so a failed tool result can be followed by a correction. */
    function scriptTurns(turns: ScriptedTurn[]) {
        turns.forEach((turn, index) => {
            const match = { userMessage: /./, sequenceIndex: index };
            if ('output' in turn) {
                mock().llm.on(match, { content: JSON.stringify(turn.output) });
                return;
            }
            mock().llm.on(match, {
                toolCalls: [
                    {
                        id: `call_${turn.tool}_${index}`,
                        name: turn.tool,
                        arguments:
                            turn.tool === 'read_source'
                                ? {
                                      repository: 'CopilotKit/CopilotKit',
                                      path: turn.path,
                                      ref: turn.ref ?? 'v2.0.0',
                                  }
                                : { repository: 'CopilotKit/CopilotKit', tag: turn.tag },
                    },
                ],
            });
        });
    }
    /** The model request that carries the result of the tool call made on `turn`. */
    function toolResultSentToModel(turn: number): string {
        return JSON.stringify(mock().llm.getRequests()[turn + 1]?.body);
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
    it.each(['../secret', '/etc/passwd', 'packages//tools.ts', 'docs/./guide.md', 'a?b', 'a\\b'])(
        'returns invalid_path without contacting GitHub and still spends the call: %s',
        async (path) => {
            const githubRequests = stubGitHub(okSourceFile);
            scriptTurns([
                { tool: 'read_source', path },
                { tool: 'read_source', path: SOURCE_PATH },
                { output: groundedReply },
            ]);

            const result = await setup().agent.investigate({
                question: 'Tools?',
                source: 'github',
            });

            expect(result.reply.decision).toBe('answer');
            expect(result.sources).toHaveLength(1);
            expect(result.sources[0].sourceUrl).toBe(BLOB_URL);
            // The rejected path never reaches the network; only the corrective read does.
            expect(githubRequests).toEqual([
                'https://api.github.com/repos/CopilotKit/CopilotKit/commits/v2.0.0',
                `https://api.github.com/repos/CopilotKit/CopilotKit/contents/${SOURCE_PATH}?ref=${PINNED_SHA}`,
            ]);
            expect(toolResultSentToModel(0)).toContain('invalid_path');
            expect(mock().llm.getRequests()).toHaveLength(3);
        },
    );
    it('recovers from a rate-limited source read without leaking the GitHub response', async () => {
        const rateLimitBody = JSON.stringify({
            message: 'API rate limit exceeded for 203.0.113.7.',
            documentation_url: 'https://docs.github.com/rest/rate-limit',
        });
        let refLookups = 0;
        const githubRequests = stubGitHub((url) =>
            url.includes('/commits/') && refLookups++ === 0
                ? new Response(rateLimitBody, { status: 403 })
                : okSourceFile(url),
        );
        scriptTurns([
            { tool: 'read_source', path: SOURCE_PATH },
            { tool: 'read_source', path: SOURCE_PATH, ref: 'main' },
            { output: groundedReply },
        ]);

        const result = await setup().agent.investigate({ question: 'Tools?', source: 'github' });

        expect(result.reply.decision).toBe('answer');
        expect(result.sources).toHaveLength(1);
        expect(result.sources[0].sourceUrl).toBe(BLOB_URL);
        expect(githubRequests).toHaveLength(3);
        const failure = toolResultSentToModel(0);
        expect(failure).toContain('unavailable');
        expect(failure).toContain('access_denied');
        expect(failure).not.toContain('203.0.113.7');
        expect(failure).not.toContain('API rate limit exceeded');
    });
    it('returns a directory read as a correctable not_a_file result', async () => {
        const listing = JSON.stringify([
            {
                name: 'tools.ts',
                path: SOURCE_PATH,
                type: 'file',
                download_url: 'https://raw.githubusercontent.com/CopilotKit/CopilotKit/main/x.ts',
            },
        ]);
        const githubRequests = stubGitHub((url) =>
            url.includes('/contents/packages?') ? new Response(listing) : okSourceFile(url),
        );
        scriptTurns([
            { tool: 'read_source', path: 'packages' },
            { tool: 'read_source', path: SOURCE_PATH },
            { output: groundedReply },
        ]);

        const result = await setup().agent.investigate({ question: 'Tools?', source: 'github' });

        expect(result.sources).toEqual([
            expect.objectContaining({ sourceUrl: BLOB_URL, content: source.content }),
        ]);
        expect(githubRequests).toHaveLength(4);
        const failure = toolResultSentToModel(0);
        expect(failure).toContain('not_a_file');
        expect(failure).not.toContain('download_url');
    });
    it('spends the tool budget on failed evidence reads without resetting it', async () => {
        const githubRequests = stubGitHub(
            () => new Response('{"message":"server boom"}', { status: 503 }),
        );
        scriptTurns([
            ...Array.from(
                { length: 6 },
                () => ({ tool: 'read_source', path: SOURCE_PATH }) as ScriptedTurn,
            ),
            { output: routeReply },
        ]);

        const result = await setup().agent.investigate({ question: 'Tools?', source: 'github' });

        expect(result.reply.decision).toBe('route');
        expect(result.sources).toEqual([]);
        expect(githubRequests).toHaveLength(6);
        expect(mock().llm.getRequests()).toHaveLength(7);
        expect(mock().llm.getLastRequest()?.body?.tools ?? []).toEqual([]);
    });
    it.each([
        {
            kind: 'AbortError',
            failure: Object.assign(new Error('The operation was aborted.'), {
                name: 'AbortError',
            }),
        },
        {
            kind: 'TimeoutError',
            failure: Object.assign(new Error('The operation was aborted due to timeout.'), {
                name: 'TimeoutError',
            }),
        },
    ])('still terminates the run when the evidence fetch raises $kind', async ({ failure }) => {
        stubGitHub(() => {
            throw failure;
        });
        scriptTurns([{ tool: 'read_source', path: SOURCE_PATH }, { output: routeReply }]);
        await expect(
            setup().agent.investigate({ question: 'Tools?', source: 'github' }),
        ).rejects.toThrow('aborted');
    });
    it('returns a model-visible too_large result for oversized source files', async () => {
        const sha = 'a'.repeat(40);
        const oversizedBody = 'x'.repeat(500_001);
        const route = {
            ...reply,
            decision: 'route',
            summary: 'The lockfile is too large to inspect in this run.',
            details: '',
            evidence: [],
            handoffReason: 'Requested source file exceeded the 500000 byte read_source limit',
        };
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
                                  content: Buffer.from(oversizedBody).toString('base64'),
                                  size: oversizedBody.length,
                              },
                    ),
                );
            }),
        );
        mock().llm.on(
            { predicate: (req) => req.messages.some((m) => m.role === 'tool') },
            { content: JSON.stringify(route) },
        );
        mock().llm.onMessage(/./, {
            toolCalls: [
                {
                    id: 'call_source',
                    name: 'read_source',
                    arguments: {
                        repository: 'CopilotKit/CopilotKit',
                        path: 'pnpm-lock.yaml',
                        ref: 'main',
                    },
                },
            ],
        });

        const result = await setup().agent.investigate({
            question: 'Inspect lockfile',
            source: 'github',
        });

        expect(result.reply.decision).toBe('route');
        expect(result.sources).toEqual([]);
        expect(githubRequests).toEqual([
            'https://api.github.com/repos/CopilotKit/CopilotKit/commits/main',
            `https://api.github.com/repos/CopilotKit/CopilotKit/contents/pnpm-lock.yaml?ref=${sha}`,
        ]);
        const modelInput = JSON.stringify(mock().llm.getLastRequest()?.body);
        expect(modelInput).toContain('too_large');
        expect(modelInput).toContain('500000');
        expect(modelInput).toContain('pnpm-lock.yaml');
        expect(modelInput).not.toContain(oversizedBody);
    });
    it('returns too_large before requiring metadata-only large object content', async () => {
        const sha = 'a'.repeat(40);
        const route = {
            ...reply,
            decision: 'route',
            summary: 'The lockfile is too large to inspect in this run.',
            details: '',
            evidence: [],
            handoffReason: 'Requested source file exceeded the 500000 byte read_source limit',
        };
        const realFetch = globalThis.fetch;
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>(async (input, init) => {
                const requestUrl = input instanceof Request ? input.url : String(input);
                if (!requestUrl.startsWith('https://api.github.com/'))
                    return realFetch(input, init);
                return new Response(
                    JSON.stringify(
                        requestUrl.includes('/commits/')
                            ? { sha }
                            : { encoding: 'none', content: '', size: 1_000_000 },
                    ),
                );
            }),
        );
        mock().llm.on(
            { predicate: (req) => req.messages.some((m) => m.role === 'tool') },
            { content: JSON.stringify(route) },
        );
        mock().llm.onMessage(/./, {
            toolCalls: [
                {
                    id: 'call_source',
                    name: 'read_source',
                    arguments: {
                        repository: 'CopilotKit/CopilotKit',
                        path: 'pnpm-lock.yaml',
                        ref: 'main',
                    },
                },
            ],
        });

        const result = await setup().agent.investigate({
            question: 'Inspect lockfile',
            source: 'github',
        });

        expect(result.reply.decision).toBe('route');
        expect(result.sources).toEqual([]);
        const modelInput = JSON.stringify(mock().llm.getLastRequest()?.body);
        expect(modelInput).toContain('too_large');
        expect(modelInput).toContain('1000000');
        expect(modelInput).toContain('500000');
    });
    it.each([
        {
            kind: 'symlink',
            payload: {
                type: 'symlink',
                size: 23,
                encoding: 'none',
                content: '',
                target: '../../elsewhere/tools.ts',
            },
            secret: 'elsewhere',
        },
        {
            kind: 'submodule',
            payload: {
                type: 'submodule',
                size: 0,
                submodule_git_url: 'https://github.com/other/vendored.git',
            },
            secret: 'vendored.git',
        },
        {
            kind: 'in-limit malformed',
            payload: { encoding: 'none', content: '', size: 500_000 },
            secret: undefined,
        },
    ])(
        'returns a model-visible unreadable result for $kind file metadata',
        async ({ payload, secret }) => {
            stubGitHub((url) =>
                url.includes('/commits/')
                    ? new Response(JSON.stringify({ sha: PINNED_SHA }))
                    : new Response(JSON.stringify(payload)),
            );
            scriptTurns([{ tool: 'read_source', path: SOURCE_PATH }, { output: routeReply }]);

            const result = await setup().agent.investigate({
                question: 'Tools?',
                source: 'github',
            });

            expect(result.reply.decision).toBe('route');
            expect(result.sources).toEqual([]);
            const failure = toolResultSentToModel(0);
            expect(failure).toContain('unreadable');
            expect(failure).toContain(SOURCE_PATH);
            if (secret) expect(failure).not.toContain(secret);
        },
    );
    it('returns an unavailable ref result when the commit payload is unusable', async () => {
        stubGitHub(() => new Response(JSON.stringify({ sha: 'not-a-commit-sha' })));
        scriptTurns([{ tool: 'read_source', path: SOURCE_PATH }, { output: routeReply }]);

        const result = await setup().agent.investigate({ question: 'Tools?', source: 'github' });

        expect(result.reply.decision).toBe('route');
        expect(toolResultSentToModel(0)).toContain('invalid_response');
    });
    it.each([
        {
            kind: 'server error',
            respond: () => new Response('{"message":"server boom"}', { status: 500 }),
            reason: 'upstream_error',
            secret: 'server boom',
        },
        {
            kind: 'unparseable body',
            respond: () => new Response('<html>blocked by edge-proxy</html>'),
            reason: 'invalid_response',
            secret: 'edge-proxy',
        },
        {
            kind: 'transport failure',
            respond: (): Response => {
                throw new TypeError('fetch failed: ECONNRESET 10.0.0.4:443');
            },
            reason: 'transport_error',
            secret: '10.0.0.4',
        },
    ])(
        'returns a bounded unavailable release result on a $kind',
        async ({ respond, reason, secret }) => {
            const githubRequests = stubGitHub(respond);
            scriptTurns([{ tool: 'read_release', tag: 'v2.0.0' }, { output: routeReply }]);

            const result = await setup().agent.investigate({
                question: 'Shipped?',
                source: 'github',
            });

            expect(result.reply.decision).toBe('route');
            expect(result.sources).toEqual([]);
            expect(githubRequests).toEqual([
                'https://api.github.com/repos/CopilotKit/CopilotKit/releases/tags/v2.0.0',
            ]);
            const failure = toolResultSentToModel(0);
            expect(failure).toContain('unavailable');
            expect(failure).toContain(reason);
            expect(failure).not.toContain(secret);
        },
    );
    it('accepts source files at the maximum reported size', async () => {
        const sha = 'a'.repeat(40);
        const url = `https://github.com/CopilotKit/CopilotKit/blob/${sha}/packages/tools.ts`;
        const output = { ...reply, evidence: [{ sourceUrl: url, quote: source.content }] };
        const realFetch = globalThis.fetch;
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>(async (input, init) => {
                const requestUrl = input instanceof Request ? input.url : String(input);
                if (!requestUrl.startsWith('https://api.github.com/'))
                    return realFetch(input, init);
                return new Response(
                    JSON.stringify(
                        requestUrl.includes('/commits/')
                            ? { sha }
                            : {
                                  encoding: 'base64',
                                  content: Buffer.from(source.content).toString('base64'),
                                  size: 500_000,
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
                        ref: 'main',
                    },
                },
            ],
        });

        const result = await setup().agent.investigate({ question: 'Tools?', source: 'github' });

        expect(result.sources[0]).toMatchObject({
            content: source.content,
            sourceUrl: url,
        });
        expect(result.reply).toEqual(validateSupportReply(output, result.sources));
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
    it('preserves completed run usage when local validation rejects the final reply', async () => {
        mock().llm.on(
            { predicate: (req) => req.messages.some((m) => m.role === 'tool') },
            {
                content: JSON.stringify({
                    ...reply,
                    evidence: [{ sourceUrl: source.sourceUrl, quote: 'Fabricated evidence.' }],
                }),
                usage: { input_tokens: 321, output_tokens: 45 },
            },
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
                        version: 'v2',
                    },
                },
            ],
        });

        try {
            await setup().agent.investigate({ question: 'Tools?', source: 'github' });
            throw new Error('expected investigation to reject');
        } catch (error) {
            expect(error).toBeInstanceOf(InvalidSupportReplyError);
            expect(error).toMatchObject({
                tokenUsage: { inputTokens: 321, outputTokens: 45 },
            });
        }
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

    describe('GitHub evidence authentication', () => {
        const SYNTHETIC_HEADER = 'Bearer ghs_syntheticplaceholdertoken';
        const sha = 'a'.repeat(40);
        const releaseUrl = 'https://github.com/CopilotKit/CopilotKit/releases/tag/v2.0.0';

        /** Records the origin and Authorization header of every captured request. */
        function captureGithub() {
            const realFetch = globalThis.fetch;
            const captured: { url: string; authorization: string | null }[] = [];
            vi.stubGlobal(
                'fetch',
                vi.fn<typeof fetch>(async (input, init) => {
                    const url = input instanceof Request ? input.url : String(input);
                    if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
                    captured.push({
                        url,
                        authorization: new Headers(init?.headers).get('authorization'),
                    });
                    return new Response(
                        JSON.stringify(
                            url.includes('/commits/')
                                ? { sha }
                                : url.includes('/releases/')
                                  ? {
                                        tag_name: 'v2.0.0',
                                        html_url: releaseUrl,
                                        body: source.content,
                                        published_at: '2026-01-01',
                                        draft: false,
                                        prerelease: false,
                                    }
                                  : {
                                        encoding: 'base64',
                                        content: Buffer.from(source.content).toString('base64'),
                                        size: source.content.length,
                                    },
                        ),
                    );
                }),
            );
            return captured;
        }

        /** read_source, then read_release, then a final answer citing the release. */
        function sourceThenRelease() {
            mock().llm.on(
                { toolCallId: 'call_release' },
                {
                    content: JSON.stringify({
                        ...reply,
                        evidence: [{ sourceUrl: releaseUrl, quote: source.content }],
                    }),
                },
            );
            mock().llm.on(
                { toolCallId: 'call_source' },
                {
                    toolCalls: [
                        {
                            id: 'call_release',
                            name: 'read_release',
                            arguments: { repository: 'CopilotKit/CopilotKit', tag: 'v2.0.0' },
                        },
                    ],
                },
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
        }

        it('authorizes every source and release request against the GitHub API origin alone', async () => {
            const captured = captureGithub();
            sourceThenRelease();
            const authorization = vi.fn(async () => SYNTHETIC_HEADER);
            const agent = new SupportAgent({
                apiKey: 'test-key',
                baseURL: mock().url,
                tracingDisabled: true,
                pathfinder: { searchEvidence: vi.fn<PathfinderClient['searchEvidence']>() },
                githubAuth: { authorization },
            });
            const result = await agent.investigate({ question: 'Shipped?', source: 'github' });
            expect(result.reply.decision).toBe('answer');
            expect(captured.map((request) => request.url)).toEqual([
                'https://api.github.com/repos/CopilotKit/CopilotKit/commits/v2.0.0',
                `https://api.github.com/repos/CopilotKit/CopilotKit/contents/packages/tools.ts?ref=${sha}`,
                'https://api.github.com/repos/CopilotKit/CopilotKit/releases/tags/v2.0.0',
            ]);
            expect(captured.map((request) => request.authorization)).toEqual([
                SYNTHETIC_HEADER,
                SYNTHETIC_HEADER,
                SYNTHETIC_HEADER,
            ]);
            // Resolved per request, so a token that expires mid-investigation is re-minted.
            expect(authorization).toHaveBeenCalledTimes(3);
        });

        it('reads public sources anonymously when the host configures no App credential', async () => {
            for (const name of ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID'])
                vi.stubEnv(name, undefined as unknown as string);
            const captured = captureGithub();
            sourceThenRelease();
            // No githubAuth: this is the constructor default every pipeline consumer gets.
            const result = await setup().agent.investigate({
                question: 'Shipped?',
                source: 'github',
            });
            expect(result.reply.decision).toBe('answer');
            expect(captured).toHaveLength(3);
            expect(captured.map((request) => request.authorization)).toEqual([null, null, null]);
        });

        // A credential failure is now shaped like every other recoverable evidence failure:
        // the investigator sees a bounded status it can route on instead of the run aborting.
        // What must not change is that the request is abandoned rather than retried bare.
        it('reports a partially configured credential as a bounded failure, never an anonymous read', async () => {
            vi.stubEnv('GITHUB_APP_ID', '123456');
            for (const name of ['GITHUB_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID'])
                vi.stubEnv(name, undefined as unknown as string);
            const githubRequests = stubGitHub(okSourceFile);
            scriptTurns([{ tool: 'read_source', path: SOURCE_PATH }, { output: routeReply }]);

            const result = await setup().agent.investigate({
                question: 'Shipped?',
                source: 'github',
            });

            expect(result.reply.decision).toBe('route');
            expect(result.sources).toEqual([]);
            // Not one request left the process, so the credential was never dropped to retry.
            expect(githubRequests).toEqual([]);
            const failure = toolResultSentToModel(0);
            expect(failure).toContain('unavailable');
            expect(failure).toContain('auth_unavailable');
            // Which variable is missing is a host configuration detail, not model evidence.
            expect(failure).not.toContain('GITHUB_PRIVATE_KEY');
        });

        it('keeps the signing key out of the model-visible result when the token exchange fails', async () => {
            const pem =
                '-----BEGIN RSA PRIVATE KEY-----\nplaceholder\n-----END RSA PRIVATE KEY-----';
            const githubRequests = stubGitHub(okSourceFile);
            scriptTurns([{ tool: 'read_source', path: SOURCE_PATH }, { output: routeReply }]);
            const failingExchange: InstallationTokenFactory = () => async () => {
                // @octokit/auth-app quotes the key it could not parse; that must not travel.
                throw new Error(`could not sign JWT with ${pem}`);
            };
            const agent = new SupportAgent({
                apiKey: 'test-key',
                baseURL: mock().url,
                tracingDisabled: true,
                pathfinder: { searchEvidence: vi.fn<PathfinderClient['searchEvidence']>() },
                githubAuth: githubEvidenceAuthFromEnv(
                    {
                        GITHUB_APP_ID: '123456',
                        GITHUB_PRIVATE_KEY: pem,
                        GITHUB_INSTALLATION_ID: '7890',
                    },
                    failingExchange,
                ),
            });

            const result = await agent.investigate({ question: 'Shipped?', source: 'github' });

            expect(result.reply.decision).toBe('route');
            expect(githubRequests).toEqual([]);
            const failure = toolResultSentToModel(0);
            expect(failure).toContain('auth_unavailable');
            expect(failure).not.toContain('BEGIN RSA PRIVATE KEY');
            expect(failure).not.toContain('placeholder');
        });

        it('still surfaces a non-credential fault in the auth resolver instead of shaping it as evidence', async () => {
            const githubRequests = stubGitHub(okSourceFile);
            scriptTurns([{ tool: 'read_source', path: SOURCE_PATH }, { output: routeReply }]);
            const agent = new SupportAgent({
                apiKey: 'test-key',
                baseURL: mock().url,
                tracingDisabled: true,
                pathfinder: { searchEvidence: vi.fn<PathfinderClient['searchEvidence']>() },
                // Not a GitHubEvidenceAuthError: a bug here must escape the model loop rather
                // than be laundered into a bounded status the investigator routes past.
                githubAuth: {
                    authorization: async () => {
                        throw new TypeError('resolver is not a function');
                    },
                },
            });

            await expect(
                agent.investigate({ question: 'Shipped?', source: 'github' }),
            ).rejects.toThrow('resolver is not a function');
            expect(githubRequests).toEqual([]);
        });
    });
});

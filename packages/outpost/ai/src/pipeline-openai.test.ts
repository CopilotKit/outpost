import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIPipeline, SUPPRESSED_RESPONSE_TEXT } from './pipeline.js';
import {
    SupportAgent,
    InvalidSupportReplyError,
    InvestigationBudgetError,
} from './support-agent.js';
import { ConfidenceScorer } from './confidence.js';
import { ResponseFormatter } from './formatter.js';
import { supportReplyDetails, validateSupportReply } from './support-reply.js';
import { useAimock } from './test-utils/aimock.js';
import type { PathfinderClient } from './pathfinder.js';
import type { SupportReply } from './support-reply.js';
import type * as ConfigModule from './config.js';

vi.mock('./config.js', async (importOriginal) => {
    const original = await importOriginal<typeof ConfigModule>();
    const config: ConfigModule.AIConfig = {
        ...original.config,
        anthropicApiKey: '',
        openaiApiKey: 'test-key',
        responseProvider: 'openai',
        responseModel: 'gpt-5.6-luna',
        confidenceModel: 'gpt-5.6-luna',
        classifierModel: 'gpt-5.6-luna',
        sentimentModel: 'gpt-5.6-luna',
    };
    return {
        ...original,
        validateConfig: () => original.validateConfig(config),
        config,
    };
});

const source = {
    title: 'Tools',
    content: 'Register frontend tools with useFrontendTool.',
    sourceUrl: 'https://docs.copilotkit.ai/tools',
    score: 0.9,
};
const reply: SupportReply = {
    decision: 'answer',
    summary: 'Register the action with `useFrontendTool`.',
    details: 'Place the tool registration in your client component.',
    apiVersion: 'v2',
    appliesTo: 'CopilotKit v2',
    evidence: [{ sourceUrl: source.sourceUrl, quote: source.content }],
    handoffReason: '',
};

const investigationFailures = [
    {
        kind: 'validation',
        ErrorType: InvalidSupportReplyError,
        diagnosis: 'Evidence quote does not match the retrieved source at private-diagnostic-url.',
    },
    {
        kind: 'budget',
        ErrorType: InvestigationBudgetError,
        diagnosis: 'Support investigation exceeded its six-tool budget while reading source.',
    },
];

async function collectText(stream: AsyncIterable<string>): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks.join('');
}

describe('OpenAI publication boundary', () => {
    const mock = useAimock();
    beforeEach(() => {
        vi.stubEnv('OPENAI_BASE_URL', mock().url);
        vi.stubEnv('OPENAI_AGENTS_DISABLE_TRACING', '1');
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });
    function failingInvestigation(error: Error) {
        return new AIPipeline({
            supportAgent: {
                investigate: async () => {
                    throw error;
                },
            },
        });
    }
    function setup(
        output: SupportReply = reply,
        confidence = '{"score":0.95,"level":"HIGH","reasoning":"Sources support the answer"}',
    ) {
        mock().llm.on(
            {
                predicate: (req) =>
                    JSON.stringify(req.messages).includes('confidence scoring system'),
            },
            { content: confidence },
        );
        mock().llm.on(
            { predicate: (req) => req.messages.some((m) => m.role === 'tool') },
            { content: JSON.stringify(output) },
        );
        mock().llm.onMessage(/./, {
            toolCalls: [
                {
                    name: 'search_evidence',
                    id: 'call_evidence',
                    arguments: {
                        query: 'tools',
                        corpus: 'copilotkit',
                        kind: 'docs',
                        version: 'v2',
                    },
                },
            ],
        });
        const searchEvidence = vi
            .fn<PathfinderClient['searchEvidence']>()
            .mockResolvedValue([source]);
        return new AIPipeline({
            supportAgent: new SupportAgent({
                apiKey: 'test-key',
                baseURL: mock().url,
                tracingDisabled: true,
                pathfinder: { searchEvidence },
            }),
        });
    }
    it('constructs default pipeline clients with only the OpenAI key and classifies using Luna', async () => {
        mock().llm.onMessage(/./, {
            content: JSON.stringify({
                priority: 'LOW',
                type: 'QUESTION',
                tags: [],
                reasoning: 'How-to',
            }),
        });
        const result = await new AIPipeline().classifyTicket('How do I configure this?');
        expect(result.type).toBe('QUESTION');
        expect(mock().llm.getLastRequest()?.body?.model).toBe('gpt-5.6-luna');
    });
    it('propagates transport failures for the worker retry policy', async () => {
        const error = new Error('Provider temporarily unavailable');
        const pipeline = failingInvestigation(error);
        await expect(pipeline.generateSupportResponse('Tools?', { source: 'github' })).rejects.toBe(
            error,
        );
    });
    it.each(
        investigationFailures.flatMap((failure) =>
            (['github', 'discord', 'web'] as const).map((platform) => ({ ...failure, platform })),
        ),
    )(
        'keeps the $kind diagnosis private for $platform handoffs',
        async ({ ErrorType, diagnosis, platform }) => {
            const score = vi.spyOn(ConfidenceScorer.prototype, 'score');
            const error = new ErrorType(diagnosis, {
                cause: { providerBody: 'RAW_PROVIDER_BODY_MUST_NOT_BE_SERIALIZED' },
            });
            const pipeline = failingInvestigation(error);
            const result = await pipeline.generateSupportResponse('Tools?', {
                source: platform,
                confidenceCalibration: 0.15,
            });

            expect(result.handoffReason).toBe(diagnosis);
            expect(result.suppressed).toBe(true);
            expect(result.confidenceLevel).toBe('LOW');
            expect(result.confidenceScore).toBeLessThan(0.4);
            expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
            expect(result.response).toBe('');
            expect(result.searchResults).toEqual([]);
            expect(result.formatted.text).toContain(SUPPRESSED_RESPONSE_TEXT);
            expect(result.formatted.details).toBeUndefined();
            expect(JSON.stringify(result.formatted)).not.toContain(diagnosis);
            expect(JSON.stringify(result)).not.toContain(
                'RAW_PROVIDER_BODY_MUST_NOT_BE_SERIALIZED',
            );

            const streamed = await collectText(
                pipeline.generateStreamingResponse('Tools?', { source: platform }),
            );
            expect(streamed).toContain(SUPPRESSED_RESPONSE_TEXT);
            expect(streamed).not.toContain(diagnosis);
            expect(streamed).not.toContain('RAW_PROVIDER_BODY_MUST_NOT_BE_SERIALIZED');
            expect(score).not.toHaveBeenCalled();
            expect(mock().llm.getRequests()).toHaveLength(0);
        },
    );
    it.each(investigationFailures)(
        'bounds the private $kind diagnosis at 2000 characters',
        async ({ ErrorType, diagnosis }) => {
            const longDiagnosis = `${diagnosis} ${'private diagnostic context '.repeat(100)}`;
            const result = await failingInvestigation(
                new ErrorType(longDiagnosis),
            ).generateSupportResponse('Tools?', { source: 'web' });

            expect(result.handoffReason).toBe(longDiagnosis.slice(0, 2000));
            expect(result.handoffReason).toHaveLength(2000);
            expect(result.formatted.text).toContain(SUPPRESSED_RESPONSE_TEXT);
            expect(result.formatted.text).not.toContain(diagnosis);
            expect(result.formatted.details).toBeUndefined();
        },
    );
    it.each(investigationFailures)(
        'retains a fallback for an empty $kind diagnosis',
        async ({ ErrorType }) => {
            const result = await failingInvestigation(new ErrorType('')).generateSupportResponse(
                'Tools?',
                { source: 'web' },
            );
            expect(result.handoffReason).toBe('Investigation failed validation or execution');
            expect(result.suppressed).toBe(true);
        },
    );
    it('publishes a verified summary and exactly one GitHub disclosure', async () => {
        const result = await setup().generateSupportResponse('Tools?', { source: 'github' });
        expect(result.suppressed).toBe(false);
        expect(result.formatted.text.startsWith(reply.summary)).toBe(true);
        expect(result.formatted.text.match(/<details>/g)).toHaveLength(1);
        expect(result.formatted.text).not.toContain(source.content);
        expect(result.confidenceScore).toBeGreaterThan(0.8);
    });
    it('gives the verifier the same later version clarification and author identity', async () => {
        await setup().generateSupportResponse('Tools?', {
            source: 'github',
            conversationHistory: [
                { role: 'user', content: 'Correction: using v2.', authorName: 'maintainer' },
            ],
        });
        const verification = mock()
            .llm.getRequests()
            .find((request) => JSON.stringify(request.body).includes('confidence scoring system'));
        expect(JSON.stringify(verification?.body)).toContain('Correction: using v2.');
        expect(JSON.stringify(verification?.body)).toContain('maintainer');
    });
    it('returns native web details separately from the visible summary', async () => {
        const result = await setup().generateSupportResponse('Tools?', { source: 'web' });
        expect(result.formatted.text).not.toContain(reply.details);
        expect(result.formatted.details).toContain(reply.details);
    });
    it('preserves explicit route diagnostics as the private handoff reason', async () => {
        const diagnosis = 'The retrieved sources do not cover the requested release.';
        const result = await setup({
            ...reply,
            decision: 'route',
            summary: 'This needs maintainer review.',
            details: '',
            evidence: [],
            handoffReason: diagnosis,
        }).generateSupportResponse('Tools?', { source: 'github' });

        expect(result.suppressed).toBe(true);
        expect(result.handoffReason).toBe(diagnosis);
        expect(result.formatted.text).toContain(SUPPRESSED_RESPONSE_TEXT);
        expect(result.formatted.text).not.toContain(diagnosis);
    });
    it('preserves completed investigator usage when local validation routes the draft', async () => {
        mock().llm.on(
            {
                predicate: (req) =>
                    JSON.stringify(req.messages).includes('confidence scoring system'),
            },
            { content: '{"score":0.95,"level":"HIGH","reasoning":"Sources support the answer"}' },
        );
        mock().llm.on(
            { predicate: (req) => req.messages.some((m) => m.role === 'tool') },
            {
                content: JSON.stringify({
                    ...reply,
                    evidence: [
                        {
                            sourceUrl: source.sourceUrl,
                            quote: 'Fabricated evidence that does not exist.',
                        },
                    ],
                }),
                usage: { input_tokens: 321, output_tokens: 45 },
            },
        );
        mock().llm.onMessage(/./, {
            toolCalls: [
                {
                    name: 'search_evidence',
                    id: 'call_evidence',
                    arguments: {
                        query: 'tools',
                        corpus: 'copilotkit',
                        kind: 'docs',
                        version: 'v2',
                    },
                },
            ],
        });
        const pipeline = new AIPipeline({
            supportAgent: new SupportAgent({
                apiKey: 'test-key',
                baseURL: mock().url,
                tracingDisabled: true,
                pathfinder: {
                    searchEvidence: vi
                        .fn<PathfinderClient['searchEvidence']>()
                        .mockResolvedValue([source]),
                },
            }),
        });
        const result = await pipeline.generateSupportResponse('Tools?', {
            source: 'github',
            confidenceCalibration: 0.15,
        });

        expect(result.suppressed).toBe(true);
        expect(result.tokenUsage).toEqual({ inputTokens: 321, outputTokens: 45 });
        expect(result.formatted.text).toContain(SUPPRESSED_RESPONSE_TEXT);
        expect(result.formatted.text).not.toContain(reply.summary);
        expect(result.formatted.details).toBeUndefined();
    });
    it('withholds invented source evidence and forces escalation despite positive feedback', async () => {
        const result = await setup({
            ...reply,
            evidence: [
                { sourceUrl: source.sourceUrl, quote: 'Fabricated evidence that does not exist.' },
            ],
        }).generateSupportResponse('Tools?', { source: 'github', confidenceCalibration: 0.15 });
        expect(result.suppressed).toBe(true);
        expect(result.confidenceScore).toBeLessThan(0.4);
        expect(result.formatted.text).toContain(SUPPRESSED_RESPONSE_TEXT);
        expect(result.formatted.text).not.toContain(reply.summary);
        expect(result.formatted.details).toBeUndefined();
    });
    it.each(['not json', '{"score":0.2,"level":"LOW","reasoning":"Unsupported"}'])(
        'withholds a draft when the verifier is unusable or rejects it: %s',
        async (score) => {
            const result = await setup(reply, score).generateSupportResponse('Tools?', {
                source: 'web',
                confidenceCalibration: 0.15,
            });
            expect(result.suppressed).toBe(true);
            expect(result.confidenceScore).toBeLessThan(0.4);
            expect(result.formatted.details).toBeUndefined();
        },
    );
    it.each(['discord', 'github', 'slack', 'teams', 'web'] as const)(
        'preserves validated details and sources exactly once in the %s string stream',
        async (platform) => {
            const text = await collectText(
                setup().generateStreamingResponse('Tools?', { source: platform }),
            );
            expect(text.split(reply.summary)).toHaveLength(2);
            expect(text.split(reply.details)).toHaveLength(2);
            expect(text.split(source.sourceUrl)).toHaveLength(2);
            if (platform === 'github') expect(text.match(/<details>/g)).toHaveLength(1);
        },
    );
    it('preserves every Discord continuation in the collected string stream', async () => {
        const longReply = validateSupportReply(
            {
                ...reply,
                details: Array.from(
                    { length: 24 },
                    (_, index) =>
                        `Step ${index + 1}: Place the tool registration in your client component. ` +
                        'Keep the registration near the interface that exposes the action so it is available when the user needs it.',
                ).join('\n\n'),
            },
            [source],
        );
        const formatted = new ResponseFormatter().formatStructured(longReply, 'discord');
        const parts = formatted.parts ?? [];
        expect(parts.length).toBeGreaterThan(1);
        expect(parts.every((part) => part.length <= 2000)).toBe(true);
        expect(parts[0]).not.toContain('Step 24:');

        const text = await collectText(
            setup(longReply).generateStreamingResponse('Tools?', { source: 'discord' }),
        );
        expect(text).toBe(parts.join('\n\n'));
        expect(text).toContain('Step 24:');
        expect(text.split(reply.summary)).toHaveLength(2);
        expect(text.split(source.sourceUrl)).toHaveLength(2);
        expect(text.split('Powered by CopilotKit AI')).toHaveLength(2);
    });
    it.each(['discord', 'github', 'web'] as const)(
        'does not leak routed drafts, handoff reasons, or details through %s streaming',
        async (platform) => {
            const pipeline = setup({
                ...reply,
                decision: 'route',
                summary: 'Internal draft for review.',
                handoffReason: 'Internal handoff reason',
                details: 'Internal investigation',
            });
            const text = await collectText(
                pipeline.generateStreamingResponse('Tools?', { source: platform }),
            );
            expect(text).toContain(SUPPRESSED_RESPONSE_TEXT);
            expect(text).not.toContain('Internal');
        },
    );

    // Streaming hands a consumer ONE string, so it has to be the whole response in
    // reading order. Web is the only source whose formatted output splits into a
    // summary pane and a details pane, and the footer closes the summary pane — so
    // web is the one source where appending the panes buried the footer mid-stream.
    it.each(['discord', 'github', 'slack', 'teams', 'web'] as const)(
        'closes the %s string stream with the footer',
        async (platform) => {
            const text = await collectText(
                setup().generateStreamingResponse('Tools?', { source: platform }),
            );
            const footer =
                platform === 'github'
                    ? 'Generated by CopilotKit AI Support'
                    : 'Powered by CopilotKit AI';

            expect(text.indexOf(footer)).toBeGreaterThan(text.indexOf(reply.details));
            expect(text.indexOf(footer)).toBeGreaterThan(text.indexOf(source.sourceUrl));
        },
    );

    it('streams the web summary, details and footer in that order, once each', async () => {
        const text = await collectText(
            setup().generateStreamingResponse('Tools?', { source: 'web' }),
        );

        expect(text.startsWith(reply.summary)).toBe(true);
        expect(text.endsWith('\n\n---\n*Powered by CopilotKit AI*')).toBe(true);
        expect(text.split('*Powered by CopilotKit AI*')).toHaveLength(2);
        expect(text.split(reply.details)).toHaveLength(2);
    });

    // An answer about embedding IS HTML, and `validateSupportReply` publishes the
    // tags it writes inside a fence or a code span — the chat surface renders
    // Markdown through ReactMarkdown with no rehype-raw, so they reach the reader
    // inert. What the stream hands a consumer has to be that same answer: a
    // serialization that deletes the `<script>` element and the `onclick` attribute
    // ships an empty fence and a dead button, which is a wrong answer rather than a
    // sanitized one. Built through the real validator so the stream is exercised on
    // what the agent actually produces.
    const htmlReply = validateSupportReply(
        {
            ...reply,
            summary: 'Mount the widget with the snippet below.',
            details:
                'Add the script and the trigger to your page:\n\n' +
                '```html\n' +
                '<script src="app.js"></script>\n' +
                '<button onclick="handleClick()">Run</button>\n' +
                '```\n\n' +
                'Use `<iframe src="embed.html"></iframe>` only inside a sandboxed page.',
        },
        [source],
    );

    it('streams validated HTML examples to the web consumer byte for byte', async () => {
        const text = await collectText(
            setup(htmlReply).generateStreamingResponse('Tools?', { source: 'web' }),
        );

        expect(text).toContain(supportReplyDetails(htmlReply));
        expect(text).toContain(
            '```html\n<script src="app.js"></script>\n<button onclick="handleClick()">Run</button>\n```',
        );
        expect(text).toContain('`<iframe src="embed.html"></iframe>`');
        expect(text.startsWith(htmlReply.summary)).toBe(true);
        expect(text.endsWith('\n\n---\n*Powered by CopilotKit AI*')).toBe(true);
        expect(text.split('*Powered by CopilotKit AI*')).toHaveLength(2);
        expect(text.split(source.sourceUrl)).toHaveLength(2);
    });
});

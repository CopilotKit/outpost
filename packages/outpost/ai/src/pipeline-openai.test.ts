import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIPipeline, SUPPRESSED_RESPONSE_TEXT } from './pipeline.js';
import { SupportAgent } from './support-agent.js';
import { ResponseFormatter } from './formatter.js';
import { validateSupportReply } from './support-reply.js';
import { useAimock } from './test-utils/aimock.js';
import type { PathfinderClient } from './pathfinder.js';
import type { SupportReply } from './support-reply.js';
import type * as ConfigModule from './config.js';

vi.mock('./config.js', async (importOriginal) => {
    const original = await importOriginal<typeof ConfigModule>();
    return {
        ...original,
        validateConfig: () =>
            original.validateConfig({
                ...original.config,
                anthropicApiKey: '',
                openaiApiKey: 'test-key',
            }),
        config: { ...original.config, anthropicApiKey: '', openaiApiKey: 'test-key' },
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
    afterEach(() => vi.unstubAllEnvs());
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
        const pipeline = new AIPipeline({
            supportAgent: {
                investigate: async () => {
                    throw new Error('Provider temporarily unavailable');
                },
            },
        });
        await expect(
            pipeline.generateSupportResponse('Tools?', { source: 'github' }),
        ).rejects.toThrow('temporarily unavailable');
    });
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
});

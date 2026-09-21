import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfidenceScorer } from './confidence.js';
import { TicketClassifier } from './classifier.js';
import { analyzeSentiment } from './sentiment.js';
import { useAimock } from './test-utils/aimock.js';
import type { AuxiliaryModelOptions } from './auxiliary-model.js';

const assessment = { score: 0.9, level: 'HIGH', reasoning: 'Evidence supports the draft' };
const classification = { priority: 'LOW', type: 'QUESTION', tags: ['hooks'], reasoning: 'How-to' };
const sentiment = { score: 12, label: 'POSITIVE' };

// No SDK stubs: these tests exercise Responses transport and runtime schema validation.
describe('Luna auxiliary calls', () => {
    const mock = useAimock();
    beforeEach(() => {
        vi.stubEnv('ANTHROPIC_API_KEY', '');
        vi.stubEnv('ANTHROPIC_BASE_URL', mock().url);
        vi.stubEnv('OPENAI_BASE_URL', mock().url);
        vi.stubEnv('OPENAI_AGENTS_DISABLE_TRACING', '1');
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });
    const options = {
        apiKey: 'test-openai',
        provider: 'openai',
        model: 'gpt-5.6-luna',
    } satisfies AuxiliaryModelOptions;

    it('independently verifies the full conversation, draft and evidence using Luna', async () => {
        mock().llm.onMessage(/./, {
            content: JSON.stringify(assessment),
            usage: { input_tokens: 123, output_tokens: 45 },
        });
        const result = await new ConfidenceScorer(options).score(
            'question and later version clarification CONTEXT_END',
            'x'.repeat(5000) + ' DRAFT_END',
            [
                {
                    title: 'Source',
                    content: 'x'.repeat(6000) + ' SOURCE_END',
                    sourceUrl: 'https://example.com/source',
                    score: 0.9,
                },
            ],
        );
        expect(result).toMatchObject({
            ...assessment,
            degraded: false,
            tokenUsage: { inputTokens: 123, outputTokens: 45 },
        });
        const request = mock().llm.getLastRequest();
        expect(request?.body?.model).toBe('gpt-5.6-luna');
        expect(JSON.stringify(request?.body)).toContain('CONTEXT_END');
        expect(JSON.stringify(request?.body)).toContain('DRAFT_END');
        expect(JSON.stringify(request?.body)).toContain('SOURCE_END');
    });

    it('classifies with Luna while retaining heuristic urgency and combined tags', async () => {
        mock().llm.onMessage(/./, {
            content: JSON.stringify(classification),
            usage: { input_tokens: 90, output_tokens: 20 },
        });
        const result = await new TicketClassifier(options).classify('Error: LangGraph hook fails');
        expect(result).toMatchObject({
            priority: 'HIGH',
            type: 'QUESTION',
            degraded: false,
            tokenUsage: { inputTokens: 90, outputTokens: 20 },
        });
        expect(result.tags).toEqual(expect.arrayContaining(['hooks', 'langgraph']));
        expect(mock().llm.getLastRequest()?.body?.model).toBe('gpt-5.6-luna');
    });

    it('keeps a critical model classification above heuristic high priority', async () => {
        mock().llm.onMessage(/./, {
            content: JSON.stringify({ ...classification, priority: 'CRITICAL' }),
        });
        expect(
            (await new TicketClassifier(options).classify('Error: LangGraph hook fails')).priority,
        ).toBe('CRITICAL');
    });

    it.each([
        'Security vulnerability in authentication',
        'Data loss, production outages have been reported.',
        'Data loss, production outages have not been reported. Production is down.',
        'Production is currently down.',
        'Our production service is completely down.',
        'The production system is still down.',
        'Data loss was not prevented.',
        'A production outage was not avoided.',
        'A security vulnerability was not prevented.',
        "Data loss wasn't prevented.",
        "Production outages weren't avoided.",
        "A security vulnerability wasn't prevented.",
        'Data loss has not been prevented.',
        'Production outages have not been avoided.',
        "Data loss hasn't been prevented.",
        "A security vulnerability hadn't been prevented.",
    ])('retains heuristic CRITICAL when Luna underestimates an incident: %s', async (content) => {
        mock().llm.onMessage(/./, { content: JSON.stringify(classification) });
        expect(await new TicketClassifier(options).classify(content)).toMatchObject({
            priority: 'CRITICAL',
            degraded: false,
        });
    });

    it.each([
        ['Security vulnerabilities were not only found, they were exploited.', 'CRITICAL'],
        ['Data loss was not only confirmed, it affected production.', 'CRITICAL'],
        ['Not only did we suffer data loss, but customers lost access.', 'CRITICAL'],
        ['Data loss did not occur.', 'HIGH'],
        ['Security vulnerabilities were not found.', 'HIGH'],
        ['Not only did we avoid data loss, we avoided a production outage.', 'HIGH'],
        ['Not only was no data loss reported, no security vulnerability was found.', 'HIGH'],
        ['Data loss was not only avoided, production outages were prevented.', 'HIGH'],
        ['Data loss was not only not observed, it never occurred.', 'HIGH'],
    ])(
        'retains the heuristic floor for not-only incident context: %s',
        async (content, priority) => {
            mock().llm.onMessage(/./, { content: JSON.stringify(classification) });
            expect(await new TicketClassifier(options).classify(content)).toMatchObject({
                priority,
                degraded: false,
            });
        },
    );

    it.each([
        'How do I prevent data loss?',
        'There was no data loss',
        'Data loss, production outages have not been reported.',
        'Data loss, production outages, and security vulnerabilities have not been reported.',
        'This does not represent data loss.',
        'This does not constitute data loss.',
        'This is unrelated to data loss.',
        "This doesn't represent a production outage.",
        "This didn't constitute a security vulnerability.",
        'These are unrelated to production outages.',
    ])(
        'does not promote a healthy LOW model to CRITICAL for a non-incident: %s',
        async (content) => {
            mock().llm.onMessage(/./, { content: JSON.stringify(classification) });
            expect(await new TicketClassifier(options).classify(content)).toMatchObject({
                priority: 'HIGH',
                degraded: false,
            });
        },
    );

    it.each([
        ['LOW', 'Did a production outage occur?'],
        ['LOW', 'Has there been data loss?'],
        ['LOW', 'Was a security vulnerability found?'],
        ['LOW', 'Were customers affected by a production outage?'],
        ['LOW', 'Have we experienced data loss?'],
        ['LOW', 'Had there been a production outage?'],
        ['LOW', 'Will this introduce a security vulnerability?'],
        ['LOW', 'Did the crash happen because data loss occurred?'],
        ['LOW', 'Did the migration fail because production is down?'],
        ['LOW', 'Can this be because data loss occurred?'],
        ['MEDIUM', 'Did a production outage occur?'],
        ['MEDIUM', 'Has there been data loss?'],
        ['MEDIUM', 'Was a security vulnerability found?'],
        ['MEDIUM', 'Were customers affected by a production outage?'],
        ['MEDIUM', 'Have we experienced data loss?'],
        ['MEDIUM', 'Had there been a production outage?'],
        ['MEDIUM', 'Will this introduce a security vulnerability?'],
    ])(
        'keeps the existing HIGH floor for a healthy %s model answering %s',
        async (priority, content) => {
            mock().llm.onMessage(/./, {
                content: JSON.stringify({ ...classification, priority }),
                usage: { input_tokens: 90, output_tokens: 20 },
            });
            expect(await new TicketClassifier(options).classify(content)).toMatchObject({
                priority: 'HIGH',
                degraded: false,
                tokenUsage: { inputTokens: 90, outputTokens: 20 },
            });
        },
    );

    it.each([
        'How do I prevent data loss?',
        'Did a production outage occur?',
        'Has there been data loss?',
        'Was a security vulnerability found?',
        'Were customers affected by a production outage?',
        'Have we experienced data loss?',
        'Had there been a production outage?',
        'Will this introduce a security vulnerability?',
    ])(
        'preserves model CRITICAL even when conservative heuristics do not escalate: %s',
        async (content) => {
            mock().llm.onMessage(/./, {
                content: JSON.stringify({ ...classification, priority: 'CRITICAL' }),
            });
            expect(await new TicketClassifier(options).classify(content)).toMatchObject({
                priority: 'CRITICAL',
                degraded: false,
            });
        },
    );

    it.each([
        'Security vulnerability exposes customer conversations',
        'Data loss after the runtime update',
        'Production outage: customers cannot connect',
    ])('preserves critical fallback after invalid Luna output: %s', async (content) => {
        mock().llm.onMessage(/./, {
            content: 'not json',
            usage: { input_tokens: 70, output_tokens: 15 },
        });
        expect(await new TicketClassifier(options).classify(content)).toMatchObject({
            priority: 'CRITICAL',
            degraded: true,
            tokenUsage: { inputTokens: 70, outputTokens: 15 },
        });
    });

    it('measures sentiment with Luna and accounts for usage', async () => {
        mock().llm.onMessage(/./, {
            content: JSON.stringify(sentiment),
            usage: { input_tokens: 80, output_tokens: 18 },
        });
        const result = await analyzeSentiment(['Thanks!', 'Working well'], options);
        expect(result).toEqual({
            ...sentiment,
            degraded: false,
            tokenUsage: { inputTokens: 80, outputTokens: 18 },
        });
        expect(mock().llm.getLastRequest()?.body?.model).toBe('gpt-5.6-luna');
    });

    it('derives the sentiment label from the rounded Luna score', async () => {
        mock().llm.onMessage(/./, {
            content: JSON.stringify({ score: 45.6, label: 'NEUTRAL' }),
            usage: { input_tokens: 80, output_tokens: 18 },
        });

        expect(await analyzeSentiment(['Customer feedback'], options)).toEqual({
            score: 46,
            label: 'NEGATIVE',
            degraded: false,
            tokenUsage: { inputTokens: 80, outputTokens: 18 },
        });
    });

    it.each([
        'not json',
        '{}',
        '{"score":null,"label":"NEUTRAL"}',
        '{"score":101,"label":"CRITICAL"}',
        '{"score":10,"label":"invented"}',
    ])('marks unusable sentiment degraded and retains billed usage: %s', async (content) => {
        mock().llm.onMessage(/./, { content, usage: { input_tokens: 70, output_tokens: 15 } });
        expect(await analyzeSentiment(['test'], options)).toMatchObject({
            score: 25,
            label: 'NEUTRAL',
            degraded: true,
            tokenUsage: { inputTokens: 70, outputTokens: 15 },
        });
    });
    it.each([
        'not json',
        '{}',
        '{"priority":"LOW","type":"QUESTION","tags":[4],"reasoning":"test"}',
    ])('marks invalid classification degraded and uses heuristics: %s', async (content) => {
        mock().llm.onMessage(/./, { content, usage: { input_tokens: 70, output_tokens: 15 } });
        expect(await new TicketClassifier(options).classify('Error: broken')).toMatchObject({
            priority: 'HIGH',
            type: 'BUG',
            degraded: true,
            tokenUsage: { inputTokens: 70, outputTokens: 15 },
        });
    });
    it.each([
        'not json',
        '{}',
        '{"score":2,"level":"HIGH","reasoning":"test"}',
        '{"score":0.9,"level":"HIGH","reasoning":12}',
    ])('marks invalid confidence degraded and retains billed usage: %s', async (content) => {
        mock().llm.onMessage(/./, { content, usage: { input_tokens: 70, output_tokens: 15 } });
        expect(await new ConfidenceScorer(options).score('q', 'draft', [])).toMatchObject({
            degraded: true,
            tokenUsage: { inputTokens: 70, outputTokens: 15 },
        });
    });
    it('fails closed on empty output within one bounded run', async () => {
        mock().llm.onMessage(/./, {
            content: '',
            usage: { input_tokens: 10, output_tokens: 2048 },
        });
        expect(await analyzeSentiment(['test'], options)).toMatchObject({
            degraded: true,
            tokenUsage: { inputTokens: 10, outputTokens: 2048 },
        });
        expect(mock().llm.getRequests()).toHaveLength(1);
    });
    it('does not log SDK failure state containing the conversation', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        mock().llm.onMessage(/./, { content: 'not json' });
        await new ConfidenceScorer(options).score('PRIVATE_CONVERSATION', 'draft', []);
        expect(logged).toHaveBeenCalledWith(expect.any(String), expect.any(String));
        expect(JSON.stringify(logged.mock.calls)).not.toContain('PRIVATE_CONVERSATION');
    });
    it('uses Responses strict output with a reasoning budget and disables storage', async () => {
        mock().llm.onMessage(/./, { content: JSON.stringify(assessment) });
        const realFetch = globalThis.fetch;
        const requests: Array<{ url: string; body: unknown }> = [];
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>(async (input, init) => {
                const request = new Request(input, init);
                requests.push({ url: request.url, body: await request.clone().json() });
                return realFetch(request);
            }),
        );
        expect((await new ConfidenceScorer(options).score('q', 'draft', [])).degraded).toBe(false);
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe(mock().url + '/responses');
        expect(requests[0].body).toMatchObject({
            model: 'gpt-5.6-luna',
            store: false,
            max_output_tokens: 4096,
            reasoning: { effort: 'low' },
            text: { format: { type: 'json_schema', strict: true } },
        });
        expect(requests[0].body).not.toHaveProperty('temperature');
    });
    it('rejects an incomplete provider response even when its JSON looks valid', async () => {
        mock().llm.onMessage(/./, {
            content: JSON.stringify(sentiment),
            usage: { input_tokens: 10, output_tokens: 2048 },
        });
        const realFetch = globalThis.fetch;
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>(async (input, init) => {
                const response = await realFetch(input, init);
                const body = await response.json();
                return Response.json({
                    ...body,
                    status: 'incomplete',
                    incomplete_details: { reason: 'max_output_tokens' },
                });
            }),
        );
        expect(await analyzeSentiment(['test'], options)).toMatchObject({
            degraded: true,
            tokenUsage: { inputTokens: 10, outputTokens: 2048 },
        });
        expect(mock().llm.getRequests()).toHaveLength(1);
    });
    it('does not switch providers after an API failure', async () => {
        mock().llm.nextRequestError(401, { message: 'Invalid test key' });
        expect(await analyzeSentiment(['test'], options)).toMatchObject({
            degraded: true,
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
        });
        expect(mock().llm.getRequests()).toHaveLength(1);
        expect(mock().llm.getLastRequest()?.body?.model).toBe('gpt-5.6-luna');
    });
});

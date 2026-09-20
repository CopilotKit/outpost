import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { LLMock } from '@copilotkit/aimock';
import { SentimentLabel } from './types.js';
import { analyzeSentiment } from './sentiment.js';

// ─── aimock setup ───────────────────────────────────────────────────────────

let mock: LLMock;
let originalBaseUrl: string | undefined;

beforeAll(async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = mock.url;
});

afterAll(async () => {
    if (originalBaseUrl === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
    } else {
        process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    }
    await mock.stop();
});

beforeEach(() => {
    mock.reset();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('analyzeSentiment', () => {
    it('should return NEUTRAL for empty message list', async () => {
        const result = await analyzeSentiment([]);

        expect(result).toEqual({
            score: 25,
            label: SentimentLabel.NEUTRAL,
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            degraded: false,
        });
        expect(mock.getRequests()).toHaveLength(0);
    });

    it.each([
        [0, 'NEGATIVE', 0, SentimentLabel.POSITIVE],
        [20.4, 'NEUTRAL', 20, SentimentLabel.POSITIVE],
        [20.5, 'POSITIVE', 21, SentimentLabel.NEUTRAL],
        [45.4, 'NEGATIVE', 45, SentimentLabel.NEUTRAL],
        [45.6, 'NEUTRAL', 46, SentimentLabel.NEGATIVE],
        [70.4, 'CRITICAL', 70, SentimentLabel.NEGATIVE],
        [70.5, 'NEGATIVE', 71, SentimentLabel.CRITICAL],
        [100, 'POSITIVE', 100, SentimentLabel.CRITICAL],
    ] as const)(
        'normalizes model score %s/%s to %s/%s using the rounded score thresholds',
        async (score, label, expectedScore, expectedLabel) => {
            mock.onMessage(/./, {
                content: JSON.stringify({ score, label }),
                usage: { input_tokens: 80, output_tokens: 18 },
            });

            expect(
                await analyzeSentiment(['Customer feedback'], {
                    provider: 'anthropic',
                    apiKey: 'test-key',
                }),
            ).toEqual({
                score: expectedScore,
                label: expectedLabel,
                tokenUsage: { inputTokens: 80, outputTokens: 18 },
                degraded: false,
            });
        },
    );

    it('should classify positive messages correctly', async () => {
        mock.onMessage(/./, {
            content: JSON.stringify({ score: 10, label: 'POSITIVE' }),
            usage: { input_tokens: 150, output_tokens: 20 },
        });

        const result = await analyzeSentiment(
            ['Thanks so much for your help!', 'This is working perfectly now.'],
            { provider: 'anthropic', apiKey: 'test-key' },
        );

        expect(result.score).toBe(10);
        expect(result.label).toBe(SentimentLabel.POSITIVE);
        expect(result.tokenUsage.inputTokens).toBe(150);
    });

    // Same first-block-only defect as the classifier and the scorer.
    it('sends no temperature at all when the model rejects one', async () => {
        mock.onMessage(/./, {
            content: JSON.stringify({ score: 10, label: 'POSITIVE' }),
            usage: { input_tokens: 10, output_tokens: 10 },
        });

        await analyzeSentiment(['thanks!'], {
            provider: 'anthropic',
            apiKey: 'test-key',
            model: 'claude-opus-5',
        });

        const body = mock.getLastRequest()?.body as Record<string, unknown>;
        expect(body.model).toBe('claude-opus-5');
        // Asserted on the VALUE, not key presence: aimock's journal is a
        // normalized view and always carries a `temperature` key, holding
        // `undefined` when we sent none.
        expect(body.temperature).toBeUndefined();
    });

    // The consequence, not just the shape: account-scoring skips its DB write
    // only when `degraded` is set, so an empty response returning a fabricated
    // NEUTRAL with degraded:false flipped a fail-closed gate to fail-open and
    // persisted a sentiment nobody measured.
    it('reports degraded when the response has no text, so the DB write is skipped', async () => {
        mock.onMessage(/./, {
            content: '',
            reasoning: 'thought about it and emitted no text',
            usage: { input_tokens: 10, output_tokens: 10 },
        });

        const result = await analyzeSentiment(['this is still broken'], {
            provider: 'anthropic',
            apiKey: 'test-key',
        });

        expect(result.degraded).toBe(true);
    });

    it('should read the score past a leading thinking block', async () => {
        mock.onMessage(/./, {
            content: JSON.stringify({ score: 65, label: 'NEGATIVE' }),
            reasoning: 'internal thinking that is not the score',
            usage: { input_tokens: 200, output_tokens: 20 },
        });

        const result = await analyzeSentiment(['This is still broken.'], {
            provider: 'anthropic',
            apiKey: 'test-key',
        });

        expect(result.score).toBe(65);
        expect(result.label).toBe(SentimentLabel.NEGATIVE);
    });

    it('should classify negative messages correctly', async () => {
        mock.onMessage(/./, {
            content: JSON.stringify({ score: 65, label: 'NEGATIVE' }),
            usage: { input_tokens: 200, output_tokens: 20 },
        });

        const result = await analyzeSentiment(
            [
                'This is broken again! I reported this last week.',
                'Nothing works, extremely frustrated.',
            ],
            { provider: 'anthropic', apiKey: 'test-key' },
        );

        expect(result.score).toBe(65);
        expect(result.label).toBe(SentimentLabel.NEGATIVE);
    });

    it('should classify critical messages correctly', async () => {
        mock.onMessage(/./, {
            content: JSON.stringify({ score: 85, label: 'CRITICAL' }),
            usage: { input_tokens: 180, output_tokens: 20 },
        });

        const result = await analyzeSentiment(
            ['We are evaluating alternatives. This product is unusable.'],
            { provider: 'anthropic', apiKey: 'test-key' },
        );

        expect(result.score).toBe(85);
        expect(result.label).toBe(SentimentLabel.CRITICAL);
    });

    it('should fall back to NEUTRAL on API failure', async () => {
        mock.nextRequestError(500, { message: 'API rate limit' });

        const result = await analyzeSentiment(['Some message content'], {
            provider: 'anthropic',
            apiKey: 'test-key',
        });

        expect(result.score).toBe(25);
        expect(result.label).toBe(SentimentLabel.NEUTRAL);
        expect(result.tokenUsage.inputTokens).toBe(0);
        expect(result.degraded).toBe(true);
    });

    it('rejects out-of-range scores as degraded', async () => {
        mock.onMessage(/./, {
            content: JSON.stringify({ score: 150, label: 'CRITICAL' }),
            usage: { input_tokens: 100, output_tokens: 20 },
        });

        const result = await analyzeSentiment(['test'], {
            provider: 'anthropic',
            apiKey: 'test-key',
        });

        expect(result.score).toBe(25);
        expect(result.label).toBe(SentimentLabel.NEUTRAL);
        expect(result.degraded).toBe(true);
    });

    it('rejects incomplete structured sentiment as degraded', async () => {
        mock.onMessage(/./, {
            content: JSON.stringify({ score: 15 }),
            usage: { input_tokens: 100, output_tokens: 20 },
        });

        const result = await analyzeSentiment(['test'], {
            provider: 'anthropic',
            apiKey: 'test-key',
        });

        expect(result.score).toBe(25);
        expect(result.label).toBe(SentimentLabel.NEUTRAL);
        expect(result.degraded).toBe(true);
    });

    it('should handle malformed JSON response gracefully', async () => {
        mock.onMessage(/./, {
            content: 'not valid json at all',
            usage: { input_tokens: 100, output_tokens: 20 },
        });

        const result = await analyzeSentiment(['test'], {
            provider: 'anthropic',
            apiKey: 'test-key',
        });

        expect(result.score).toBe(25);
        expect(result.label).toBe(SentimentLabel.NEUTRAL);
        expect(result.degraded).toBe(true);
        // Token usage still tracked even with parse failure
        expect(result.tokenUsage.inputTokens).toBe(100);
    });

    it('should batch multiple messages into a single API call', async () => {
        mock.onMessage(/./, {
            content: JSON.stringify({ score: 35, label: 'NEUTRAL' }),
            usage: { input_tokens: 300, output_tokens: 20 },
        });

        await analyzeSentiment(['Message 1', 'Message 2', 'Message 3'], {
            provider: 'anthropic',
            apiKey: 'test-key',
        });

        // Verify the request was made and contains all messages
        const lastReq = mock.getLastRequest();
        expect(lastReq).not.toBeNull();

        const body = lastReq!.body;
        expect(body).not.toBeNull();
        const userMessage = body!.messages.find((m: { role: string }) => m.role === 'user');
        expect(userMessage).toBeDefined();
        const content = typeof userMessage!.content === 'string' ? userMessage!.content : '';
        expect(content).toContain('[Message 1]');
        expect(content).toContain('[Message 2]');
        expect(content).toContain('[Message 3]');
    });
});

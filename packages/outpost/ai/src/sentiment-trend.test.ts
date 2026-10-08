import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SentimentLabel } from './types.js';

// Mock the sentiment module
const mockAnalyzeSentiment = vi.fn();
vi.mock('./sentiment.js', () => ({
    analyzeSentiment: (...args: unknown[]) => mockAnalyzeSentiment(...args),
}));

// Import after mocks
const { getSentimentTrend } = await import('./sentiment-trend.js');

describe('getSentimentTrend', () => {
    beforeEach(() => {
        mockAnalyzeSentiment.mockReset();
    });

    it('should return STABLE with empty periods', async () => {
        const result = await getSentimentTrend([], []);

        expect(result.periods).toHaveLength(0);
        expect(result.trend).toBe('STABLE');
        expect(result.delta).toBe(0);
    });

    it('should detect DECLINING trend when sentiment worsens over time', async () => {
        // First period: happy (low negativity)
        mockAnalyzeSentiment.mockResolvedValueOnce({
            score: 15,
            label: SentimentLabel.POSITIVE,
            tokenUsage: { inputTokens: 100, outputTokens: 20 },
        });
        // Second period: unhappy (high negativity)
        mockAnalyzeSentiment.mockResolvedValueOnce({
            score: 60,
            label: SentimentLabel.NEGATIVE,
            tokenUsage: { inputTokens: 100, outputTokens: 20 },
        });

        const now = new Date();
        const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const result = await getSentimentTrend(
            [
                { content: 'Great product!', createdAt: new Date(twoWeeksAgo.getTime() + 1000) },
                {
                    content: 'This is terrible now.',
                    createdAt: new Date(oneWeekAgo.getTime() + 1000),
                },
            ],
            [
                { start: twoWeeksAgo, end: oneWeekAgo },
                { start: oneWeekAgo, end: now },
            ],
        );

        expect(result.trend).toBe('DECLINING');
        expect(result.delta).toBe(45); // 60 - 15
        expect(result.periods).toHaveLength(2);
        expect(result.periods[0].score).toBe(15);
        expect(result.periods[1].score).toBe(60);
    });

    it('should detect IMPROVING trend when sentiment gets better', async () => {
        mockAnalyzeSentiment.mockResolvedValueOnce({
            score: 70,
            label: SentimentLabel.NEGATIVE,
            tokenUsage: { inputTokens: 100, outputTokens: 20 },
        });
        mockAnalyzeSentiment.mockResolvedValueOnce({
            score: 20,
            label: SentimentLabel.NEUTRAL,
            tokenUsage: { inputTokens: 100, outputTokens: 20 },
        });

        const now = new Date();
        const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const result = await getSentimentTrend(
            [
                { content: 'Frustrated', createdAt: new Date(twoWeeksAgo.getTime() + 1000) },
                { content: 'Things are better', createdAt: new Date(oneWeekAgo.getTime() + 1000) },
            ],
            [
                { start: twoWeeksAgo, end: oneWeekAgo },
                { start: oneWeekAgo, end: now },
            ],
        );

        expect(result.trend).toBe('IMPROVING');
        expect(result.delta).toBe(-50); // 20 - 70
    });

    it('should return STABLE when sentiment change is within threshold', async () => {
        mockAnalyzeSentiment.mockResolvedValueOnce({
            score: 40,
            label: SentimentLabel.NEUTRAL,
            tokenUsage: { inputTokens: 100, outputTokens: 20 },
        });
        mockAnalyzeSentiment.mockResolvedValueOnce({
            score: 45,
            label: SentimentLabel.NEUTRAL,
            tokenUsage: { inputTokens: 100, outputTokens: 20 },
        });

        const now = new Date();
        const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const result = await getSentimentTrend(
            [
                { content: 'msg1', createdAt: new Date(twoWeeksAgo.getTime() + 1000) },
                { content: 'msg2', createdAt: new Date(oneWeekAgo.getTime() + 1000) },
            ],
            [
                { start: twoWeeksAgo, end: oneWeekAgo },
                { start: oneWeekAgo, end: now },
            ],
        );

        expect(result.trend).toBe('STABLE');
        expect(result.delta).toBe(5);
    });

    it('should handle periods with no messages as NEUTRAL', async () => {
        mockAnalyzeSentiment.mockResolvedValueOnce({
            score: 30,
            label: SentimentLabel.NEUTRAL,
            tokenUsage: { inputTokens: 100, outputTokens: 20 },
        });

        const now = new Date();
        const threeWeeksAgo = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000);
        const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const result = await getSentimentTrend(
            [
                // Only one message, in the first period
                { content: 'hello', createdAt: new Date(threeWeeksAgo.getTime() + 1000) },
            ],
            [
                { start: threeWeeksAgo, end: twoWeeksAgo },
                { start: twoWeeksAgo, end: oneWeekAgo }, // Empty period
                { start: oneWeekAgo, end: now }, // Empty period
            ],
        );

        expect(result.periods).toHaveLength(3);
        expect(result.periods[0].messageCount).toBe(1);
        expect(result.periods[1].messageCount).toBe(0);
        expect(result.periods[1]).toMatchObject({
            score: 25,
            label: SentimentLabel.NEUTRAL,
            messageCount: 0,
        });
        expect(result.periods[2]).toMatchObject({
            score: 25,
            label: SentimentLabel.NEUTRAL,
            messageCount: 0,
        });
        // Only one non-empty period, so trend is STABLE (can't compare)
        expect(result.trend).toBe('STABLE');
        expect(result.delta).toBe(0);
        expect(mockAnalyzeSentiment).toHaveBeenCalledTimes(1);
    });

    it('should correctly group messages into their respective periods', async () => {
        mockAnalyzeSentiment.mockResolvedValueOnce({
            score: 20,
            label: SentimentLabel.POSITIVE,
            tokenUsage: { inputTokens: 100, outputTokens: 20 },
        });
        mockAnalyzeSentiment.mockResolvedValueOnce({
            score: 50,
            label: SentimentLabel.NEUTRAL,
            tokenUsage: { inputTokens: 100, outputTokens: 20 },
        });

        const now = new Date();
        const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        await getSentimentTrend(
            [
                { content: 'early msg 1', createdAt: new Date(twoWeeksAgo.getTime() + 1000) },
                { content: 'early msg 2', createdAt: new Date(twoWeeksAgo.getTime() + 2000) },
                { content: 'late msg 1', createdAt: new Date(oneWeekAgo.getTime() + 1000) },
            ],
            [
                { start: twoWeeksAgo, end: oneWeekAgo },
                { start: oneWeekAgo, end: now },
            ],
        );

        // First call: 2 messages from first period
        expect(mockAnalyzeSentiment.mock.calls[0][0]).toHaveLength(2);
        expect(mockAnalyzeSentiment.mock.calls[0][0]).toContain('early msg 1');
        expect(mockAnalyzeSentiment.mock.calls[0][0]).toContain('early msg 2');
        // Second call: 1 message from second period
        expect(mockAnalyzeSentiment.mock.calls[1][0]).toHaveLength(1);
        expect(mockAnalyzeSentiment.mock.calls[1][0]).toContain('late msg 1');
    });
});

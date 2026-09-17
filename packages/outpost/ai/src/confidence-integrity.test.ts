import { describe, expect, it } from 'vitest';
import { ConfidenceScorer } from './confidence.js';
import { useAimock } from './test-utils/aimock.js';

describe('confidence integrity', () => {
    const mock = useAimock();
    it.each(['not json', '{"score":"NaN"}', '{"score":null}', '{"reasoning":"looks good"}'])(
        'preserves degraded status for invalid assessment %s',
        async (content) => {
            mock().llm.onMessage(/./, { content });
            const scorer = new ConfidenceScorer({ apiKey: 'test-key', baseURL: mock().url });
            const result = await scorer.score('question', 'answer', []);
            expect(result.degraded).toBe(true);
            expect(Number.isFinite(result.score)).toBe(true);
        },
    );
    it('scores the complete bounded draft and evidence', async () => {
        mock().llm.onMessage(/./, { content: '{"score":0.7,"reasoning":"checked"}' });
        await new ConfidenceScorer({ apiKey: 'test-key', baseURL: mock().url }).score(
            'question',
            'x'.repeat(2100) + ' DRAFT_END',
            [{ title: 'Source', content: 'x'.repeat(700) + ' SOURCE_END', score: 0.9 }],
        );
        const request = JSON.stringify(mock().llm.getLastRequest()?.body);
        expect(request).toContain('DRAFT_END');
        expect(request).toContain('SOURCE_END');
    });
});

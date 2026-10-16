import { describe, expect, it } from 'vitest';
import { AuxiliaryModel } from './auxiliary-model.js';

describe('AuxiliaryModel provider validation', () => {
    it.each(['gpt-5.6-luna', 'o1', 'o3', 'o4-mini'])(
        'rejects an explicit OpenAI model %s under Anthropic before a request can run',
        (model) => {
            expect(
                () =>
                    new AuxiliaryModel('claude-haiku-4-5-20251001', {
                        provider: 'anthropic',
                        model,
                    }),
            ).toThrow('[AI Config] auxiliary model does not match AI_RESPONSE_PROVIDER');
        },
    );

    it('continues rejecting Claude models under OpenAI', () => {
        expect(
            () =>
                new AuxiliaryModel('gpt-5.6-luna', {
                    provider: 'openai',
                    model: 'claude-haiku-4-5-20251001',
                }),
        ).toThrow('[AI Config] auxiliary model does not match AI_RESPONSE_PROVIDER');
    });

    it.each(['claude-haiku-4-5-20251001', 'custom-anthropic-deployment', 'o3custom-deployment'])(
        'preserves Anthropic or custom model %s',
        (model) => {
            expect(
                () =>
                    new AuxiliaryModel('claude-haiku-4-5-20251001', {
                        provider: 'anthropic',
                        model,
                    }),
            ).not.toThrow();
        },
    );
});

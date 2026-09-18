import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from './config.js';

describe('validateConfig', () => {
    const defaults = {
        anthropicApiKey: 'test-anthropic',
        openaiApiKey: 'test-openai',
        responseProvider: 'openai',
        responseModel: 'gpt-5.6-luna',
        draftLintMode: 'report',
    };
    it('accepts an OpenAI-only default configuration', () =>
        expect(() => validateConfig({ ...defaults, anthropicApiKey: '' })).not.toThrow());
    it('requires Anthropic only for explicit rollback', () =>
        expect(() =>
            validateConfig({
                ...defaults,
                responseProvider: 'anthropic',
                responseModel: 'claude-sonnet-4-6',
                anthropicApiKey: '',
            }),
        ).toThrow('ANTHROPIC_API_KEY'));
    it('requires an OpenAI key for the default provider', () =>
        expect(() => validateConfig({ ...defaults, openaiApiKey: '' })).toThrow('OPENAI_API_KEY'));
    it('supports an explicit Anthropic rollback without an OpenAI key', () =>
        expect(() =>
            validateConfig({
                ...defaults,
                responseProvider: 'anthropic',
                responseModel: 'claude-sonnet-4-6',
                openaiApiKey: '',
            }),
        ).not.toThrow());
    it('accepts a configured default', () => expect(() => validateConfig(defaults)).not.toThrow());
    it('rejects a model for the wrong provider', () =>
        expect(() => validateConfig({ ...defaults, responseModel: 'claude-sonnet-4-6' })).toThrow(
            'does not match',
        ));
    it.each(['confidenceModel', 'classifierModel', 'sentimentModel'] as const)(
        'rejects a mismatched %s override',
        (key) => {
            expect(() =>
                validateConfig({ ...defaults, [key]: 'claude-haiku-4-5-20251001' }),
            ).toThrow('does not match');
            expect(() =>
                validateConfig({
                    ...defaults,
                    responseProvider: 'anthropic',
                    responseModel: 'claude-sonnet-4-6',
                    [key]: 'gpt-5.6-luna',
                }),
            ).toThrow('does not match');
        },
    );
    it('rejects provider typos', () =>
        expect(() => validateConfig({ ...defaults, responseProvider: 'opeani' })).toThrow(
            'AI_RESPONSE_PROVIDER',
        ));
    it('rejects unknown lint mode', () =>
        expect(() => validateConfig({ ...defaults, draftLintMode: 'off' })).toThrow(
            'AI_DRAFT_LINT_MODE',
        ));
});

describe('provider model defaults', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });
    it.each(['openai', 'anthropic'] as const)(
        'uses only the %s key for all default stages',
        async (provider) => {
            vi.resetModules();
            vi.stubEnv('AI_RESPONSE_PROVIDER', provider);
            for (const name of [
                'AI_RESPONSE_MODEL',
                'AI_CONFIDENCE_MODEL',
                'AI_CLASSIFIER_MODEL',
                'AI_SENTIMENT_MODEL',
            ])
                vi.stubEnv(name, '');
            vi.stubEnv('OPENAI_API_KEY', provider === 'openai' ? 'test-openai' : '');
            vi.stubEnv('ANTHROPIC_API_KEY', provider === 'anthropic' ? 'test-anthropic' : '');
            const { config: values, validateConfig: validate } = await import('./config.js');
            expect(() => validate()).not.toThrow();
            const expected = provider === 'openai' ? 'gpt-5.6-luna' : 'claude-haiku-4-5-20251001';
            expect(values.confidenceModel).toBe(expected);
            expect(values.classifierModel).toBe(expected);
            expect(values.sentimentModel).toBe(expected);
        },
    );
});

import { describe, expect, it } from 'vitest';
import { validateConfig } from './config.js';

describe('validateConfig', () => {
    const defaults = {
        anthropicApiKey: 'test-anthropic',
        openaiApiKey: 'test-openai',
        responseProvider: 'openai',
        responseModel: 'gpt-5.6-luna',
        draftLintMode: 'report',
    };
    it('requires the existing scoring key', () =>
        expect(() => validateConfig({ ...defaults, anthropicApiKey: '' })).toThrow(
            'ANTHROPIC_API_KEY',
        ));
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
    it('rejects provider typos', () =>
        expect(() => validateConfig({ ...defaults, responseProvider: 'opeani' })).toThrow(
            'AI_RESPONSE_PROVIDER',
        ));
    it('rejects unknown lint mode', () =>
        expect(() => validateConfig({ ...defaults, draftLintMode: 'off' })).toThrow(
            'AI_DRAFT_LINT_MODE',
        ));
});

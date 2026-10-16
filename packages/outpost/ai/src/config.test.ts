import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateConfig, validateModelProvider } from './config.js';

const { loadConfig } = vi.hoisted(() => ({ loadConfig: () => import('./config.js') }));
const fineTunedGpt41 = 'ft:gpt-4.1:org:job';
const fineTunedGpt4o = 'ft:gpt-4o-mini:openai:custom-model-name:7p4lURel';
/**
 * Fine-tuned o-series identifier, evidence status per r12-openai-finetuning-evidence.md
 * (primary sources checked 2026-09-21):
 *   DOCUMENTED — `o4-mini-2025-04-16` is named as a reinforcement-fine-tuning base model, and
 *     callers are instructed to use output-model IDs beginning `ft:`. Both halves are real.
 *   INFERRED — the concatenated spelling below was NOT observed as a literal example on either
 *     page; it follows from combining the documented RFT base with the documented `ft:`
 *     output-ID rule. (The deprecations page's `ft-o4-mini-2025-04-16` uses a hyphen and is a
 *     different label, not the colon customer-model-ID format.)
 * This fixture asserts how the guard classifies an identifier SHAPE. It does not assert that
 * this identifier is an available model on any account.
 */
const fineTunedO4Mini = 'ft:o4-mini-2025-04-16:org:job';
const modelForms = (model: string) => [model, `  ${model}  `];

/**
 * Closure invariant for provider-family recognition (R12-LEVER-A02-PROVIDER-FAMILY-CLOSURE).
 *
 * Five REPRESENTATIVES of the families the guard already recognizes bare — deliberately not an
 * inventory, and this array must not grow into a general OpenAI model catalog. Each base is
 * derived below into its bare form and its `ft:` customer-model-ID form inside the SAME loop, so
 * a base recognized bare but not under `ft:` fails, and the inverse fails too. That derived
 * relation is the point: rounds 10-12 each hand-wrote one half of it and missed the other.
 *
 * Evidence status of the derived `ft:` fixtures, so no row overclaims (see fineTunedO4Mini above
 * for the documented/inferred split on `ft:o4-mini-2025-04-16:...`):
 *   SYNTHETIC CLOSURE CONTROL — `ft:gpt-4.1:...`, `ft:o1:...`, `ft:o3:...` and
 *     `ft:chat-latest:...` are shape fixtures over bases the guard already classifies as OpenAI.
 *     No documentation is claimed for them and none is required. They pin the bare/`ft:`
 *     relation; they do NOT assert that any of these is an available fine-tuned OpenAI model.
 */
const RECOGNIZED_OPENAI_BASES = ['gpt-4.1', 'o1', 'o3', 'o4-mini-2025-04-16', 'chat-latest'];

/**
 * Names that must stay accepted under Anthropic as custom provider deployments. Each embeds a
 * recognized token (`custom-anthropic-deployment`, the `chat-latest` prefix, the `ft:` prefix)
 * without being a recognized identifier, so a broadening of the guard shows up here as a
 * rejection. Compared exactly — case is preserved, never folded (R12-AI-DESIGN01 refuted).
 */
const PROTECTED_CUSTOM_DEPLOYMENTS = [
    'custom-anthropic-deployment',
    'chat-latest-custom',
    'ft:custom-deployment',
];

describe('validateConfig', () => {
    const defaults = {
        anthropicApiKey: 'test-anthropic',
        openaiApiKey: 'test-openai',
        responseProvider: 'openai',
        responseModel: 'gpt-5.6-luna',
        draftLintMode: 'report',
    };

    describe('normalized provider identity', () => {
        it.each(
            [
                { provider: 'anthropic', model: 'gpt-5.6-luna', accepted: false },
                { provider: 'anthropic', model: 'o3', accepted: false },
                { provider: 'anthropic', model: 'chat-latest', accepted: false },
                { provider: 'anthropic', model: fineTunedGpt41, accepted: false },
                { provider: 'openai', model: 'claude-sonnet-4-6', accepted: false },
                { provider: 'anthropic', model: 'custom-anthropic-deployment', accepted: true },
            ].flatMap((row) => modelForms(row.model).map((model) => ({ ...row, model }))),
        )('preserves response identity for $provider / $model', ({ provider, model, accepted }) => {
            const validate = () =>
                validateConfig({ ...defaults, responseProvider: provider, responseModel: model });
            if (accepted) expect(validate).not.toThrow();
            else expect(validate).toThrow('AI_RESPONSE_MODEL does not match AI_RESPONSE_PROVIDER');
        });

        // `auxiliary model` is the exact name AuxiliaryModel's constructor passes, so these rows
        // pin the shared direct call site as well as validateConfig's four configured roles.
        it.each(
            ['openai', 'anthropic'].flatMap((provider) =>
                [fineTunedGpt41, fineTunedO4Mini].flatMap((base) =>
                    modelForms(base).map((model) => ({ provider, model })),
                ),
            ),
        )('checks direct fine-tuned identity for $provider / $model', ({ provider, model }) => {
            const validate = () => validateModelProvider(provider, model, 'auxiliary model');
            if (provider === 'openai') expect(validate).not.toThrow();
            else expect(validate).toThrow('auxiliary model does not match AI_RESPONSE_PROVIDER');
        });

        it.each(
            (['confidenceModel', 'classifierModel', 'sentimentModel'] as const).flatMap((key) =>
                modelForms(fineTunedGpt41).map((model) => ({ key, model })),
            ),
        )('rejects fine-tuned identity in $key / $model', ({ key, model }) => {
            expect(() =>
                validateConfig({
                    ...defaults,
                    responseProvider: 'anthropic',
                    responseModel: 'claude-sonnet-4-6',
                    [key]: model,
                }),
            ).toThrow('does not match AI_RESPONSE_PROVIDER');
        });
    });

    describe('recognized-base closure across the ft: namespace', () => {
        // Bare and ft: forms are generated from RECOGNIZED_OPENAI_BASES in one loop, and both
        // provider expectations from one array, so the four halves cannot drift apart.
        // Padding appears on the ft: form only; bare padding is already owned by R8-LEVER-A03.
        it.each(
            RECOGNIZED_OPENAI_BASES.flatMap((base) =>
                [base, `ft:${base}:org:job`, `  ft:${base}:org:job  `].flatMap((model) =>
                    (['anthropic', 'openai'] as const).map((provider) => ({
                        base,
                        model,
                        provider,
                    })),
                ),
            ),
        )('classifies $base as OpenAI in form $model under $provider', ({ model, provider }) => {
            const validate = () =>
                validateConfig({ ...defaults, responseProvider: provider, responseModel: model });
            if (provider === 'openai') expect(validate).not.toThrow();
            else expect(validate).toThrow('AI_RESPONSE_MODEL does not match AI_RESPONSE_PROVIDER');
        });

        it.each(PROTECTED_CUSTOM_DEPLOYMENTS.flatMap(modelForms))(
            'keeps custom Anthropic deployment %j accepted',
            (model) => {
                expect(() =>
                    validateConfig({
                        ...defaults,
                        responseProvider: 'anthropic',
                        responseModel: model,
                    }),
                ).not.toThrow();
            },
        );
    });

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
    it.each([
        ['openai', 'openaiApiKey', 'OPENAI_API_KEY'],
        ['anthropic', 'anthropicApiKey', 'ANTHROPIC_API_KEY'],
    ] as const)('rejects a blank selected %s API key', (provider, key, envName) => {
        expect(() =>
            validateConfig({
                ...defaults,
                responseProvider: provider,
                responseModel: provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.6-luna',
                [key]: '   ',
            }),
        ).toThrow(envName);
    });
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
    describe.each([
        ['responseModel', 'AI_RESPONSE_MODEL'],
        ['confidenceModel', 'AI_CONFIDENCE_MODEL'],
        ['classifierModel', 'AI_CLASSIFIER_MODEL'],
        ['sentimentModel', 'AI_SENTIMENT_MODEL'],
    ] as const)('%s provider validation', (key, name) => {
        it.each([
            ['anthropic', 'claude-sonnet-4-6', '  gpt-5.6-luna  '],
            ['anthropic', 'claude-sonnet-4-6', '  chat-latest  '],
            ['openai', 'gpt-5.6-luna', '  claude-sonnet-4-6  '],
        ] as const)(
            'rejects whitespace-padded known-family mismatch %s / %s',
            (provider, responseModel, model) => {
                expect(() =>
                    validateConfig({
                        ...defaults,
                        responseProvider: provider,
                        responseModel: key === 'responseModel' ? model : responseModel,
                        [key]: model,
                    }),
                ).toThrow(`[AI Config] ${name} does not match AI_RESPONSE_PROVIDER`);
            },
        );

        it.each([
            ['anthropic', 'claude-sonnet-4-6', '  claude-haiku-4-5-20251001  '],
            ['openai', 'gpt-5.6-luna', '  gpt-5.6-luna  '],
            ['openai', 'gpt-5.6-luna', '  azure-prod-deployment  '],
            ['anthropic', 'claude-sonnet-4-6', '  custom-anthropic-deployment  '],
        ] as const)(
            'accepts whitespace-padded valid/custom model %s / %s',
            (provider, responseModel, model) => {
                expect(() =>
                    validateConfig({
                        ...defaults,
                        responseProvider: provider,
                        responseModel: key === 'responseModel' ? model : responseModel,
                        [key]: model,
                    }),
                ).not.toThrow();
            },
        );

        it.each([
            'gpt-5.6-luna',
            'chat-latest',
            ...modelForms(fineTunedGpt4o),
            ...modelForms(fineTunedO4Mini),
            'o1',
            'o1-preview',
            'o3',
            'o3-pro',
            'o3-2025-04-16',
            'o4-mini',
            'o4-mini-2025-04-16',
        ])('rejects known OpenAI model %s under Anthropic', (model) => {
            expect(() =>
                validateConfig({
                    ...defaults,
                    responseProvider: 'anthropic',
                    responseModel: 'claude-sonnet-4-6',
                    [key]: model,
                }),
            ).toThrow(`[AI Config] ${name} does not match AI_RESPONSE_PROVIDER`);
        });

        it.each([
            'claude-sonnet-4-6',
            'custom-anthropic-deployment',
            'o3custom-deployment',
            'chat-custom-deployment',
            'chat-latest-custom',
            'ft:custom-deployment',
            'custom-gpt-deployment',
        ])('accepts Anthropic or custom model %s', (model) => {
            expect(() =>
                validateConfig({
                    ...defaults,
                    responseProvider: 'anthropic',
                    responseModel: 'claude-sonnet-4-6',
                    [key]: model,
                }),
            ).not.toThrow();
        });

        it.each([
            'o1',
            'o3',
            'o4-mini',
            'chat-latest',
            ...modelForms(fineTunedGpt41),
            ...modelForms(fineTunedGpt4o),
            ...modelForms(fineTunedO4Mini),
        ])('accepts known OpenAI model %s under OpenAI', (model) => {
            expect(() => validateConfig({ ...defaults, [key]: model })).not.toThrow();
        });

        it('accepts a nonblank custom OpenAI deployment name', () => {
            expect(() =>
                validateConfig({ ...defaults, [key]: 'azure-prod-deployment' }),
            ).not.toThrow();
        });

        it.each(['openai', 'anthropic'] as const)(
            'rejects a direct blank %s model value',
            (provider) => {
                expect(() =>
                    validateConfig({
                        ...defaults,
                        responseProvider: provider,
                        responseModel:
                            key === 'responseModel'
                                ? '   '
                                : provider === 'anthropic'
                                  ? 'claude-sonnet-4-6'
                                  : 'gpt-5.6-luna',
                        [key]: '   ',
                    }),
                ).toThrow(`[AI Config] ${name} must not be blank`);
            },
        );
    });
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
    it.each([undefined, ''])('defaults to OpenAI when the provider is %j', async (provider) => {
        vi.resetModules();
        vi.stubEnv('AI_RESPONSE_PROVIDER', provider);
        for (const name of [
            'AI_RESPONSE_MODEL',
            'AI_CONFIDENCE_MODEL',
            'AI_CLASSIFIER_MODEL',
            'AI_SENTIMENT_MODEL',
        ])
            vi.stubEnv(name, '');
        vi.stubEnv('OPENAI_API_KEY', 'test-openai');
        vi.stubEnv('ANTHROPIC_API_KEY', '');
        const { config: values, validateConfig: validate } = await loadConfig();
        expect(values.responseProvider).toBe('openai');
        expect(() => validate()).not.toThrow();
    });

    it.each(['   ', ' openai ', ' anthropic '])(
        'continues rejecting whitespace in provider value %j',
        async (provider) => {
            vi.resetModules();
            vi.stubEnv('AI_RESPONSE_PROVIDER', provider);
            vi.stubEnv('OPENAI_API_KEY', 'test-openai');
            vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic');
            const { validateConfig: validate } = await loadConfig();
            expect(() => validate()).toThrow('AI_RESPONSE_PROVIDER must be openai or anthropic');
        },
    );

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
            const { config: values, validateConfig: validate } = await loadConfig();
            expect(() => validate()).not.toThrow();
            const expected = provider === 'openai' ? 'gpt-5.6-luna' : 'claude-haiku-4-5-20251001';
            expect(values.confidenceModel).toBe(expected);
            expect(values.classifierModel).toBe(expected);
            expect(values.sentimentModel).toBe(expected);
        },
    );

    it.each([
        ['anthropic', 'AI_RESPONSE_MODEL', '  gpt-5.6-luna  '],
        ['anthropic', 'AI_CONFIDENCE_MODEL', '  gpt-5.6-luna  '],
        ['anthropic', 'AI_CLASSIFIER_MODEL', '  gpt-5.6-luna  '],
        ['anthropic', 'AI_SENTIMENT_MODEL', '  gpt-5.6-luna  '],
        ['anthropic', 'AI_RESPONSE_MODEL', '  chat-latest  '],
        ['anthropic', 'AI_CONFIDENCE_MODEL', '  chat-latest  '],
        ['anthropic', 'AI_CLASSIFIER_MODEL', '  chat-latest  '],
        ['anthropic', 'AI_SENTIMENT_MODEL', '  chat-latest  '],
        ['openai', 'AI_RESPONSE_MODEL', '  claude-sonnet-4-6  '],
        ['openai', 'AI_CONFIDENCE_MODEL', '  claude-haiku-4-5-20251001  '],
        ['openai', 'AI_CLASSIFIER_MODEL', '  claude-haiku-4-5-20251001  '],
        ['openai', 'AI_SENTIMENT_MODEL', '  claude-haiku-4-5-20251001  '],
    ] as const)(
        'rejects whitespace-padded known-family mismatch from %s %s',
        async (provider, envName, model) => {
            vi.resetModules();
            vi.stubEnv('AI_RESPONSE_PROVIDER', provider);
            vi.stubEnv(
                'AI_RESPONSE_MODEL',
                provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.6-luna',
            );
            vi.stubEnv(envName, model);
            vi.stubEnv('OPENAI_API_KEY', provider === 'openai' ? 'test-openai' : '');
            vi.stubEnv('ANTHROPIC_API_KEY', provider === 'anthropic' ? 'test-anthropic' : '');
            const { validateConfig: validate } = await loadConfig();
            expect(() => validate()).toThrow('does not match AI_RESPONSE_PROVIDER');
        },
    );

    it.each([
        ['anthropic', 'AI_RESPONSE_MODEL', '  claude-sonnet-4-6  ', 'claude-sonnet-4-6'],
        [
            'anthropic',
            'AI_CONFIDENCE_MODEL',
            '  claude-haiku-4-5-20251001  ',
            'claude-haiku-4-5-20251001',
        ],
        ['openai', 'AI_RESPONSE_MODEL', '  gpt-5.6-luna  ', 'gpt-5.6-luna'],
        ['openai', 'AI_RESPONSE_MODEL', '  chat-latest  ', 'chat-latest'],
        ['openai', 'AI_CLASSIFIER_MODEL', '  azure-prod-deployment  ', 'azure-prod-deployment'],
    ] as const)('trims accepted %s %s override', async (provider, envName, model, expected) => {
        vi.resetModules();
        vi.stubEnv('AI_RESPONSE_PROVIDER', provider);
        vi.stubEnv(envName, model);
        vi.stubEnv('OPENAI_API_KEY', provider === 'openai' ? 'test-openai' : '');
        vi.stubEnv('ANTHROPIC_API_KEY', provider === 'anthropic' ? 'test-anthropic' : '');
        const { config: values, validateConfig: validate } = await loadConfig();
        expect(() => validate()).not.toThrow();
        const keyByEnv = {
            AI_RESPONSE_MODEL: 'responseModel',
            AI_CONFIDENCE_MODEL: 'confidenceModel',
            AI_CLASSIFIER_MODEL: 'classifierModel',
            AI_SENTIMENT_MODEL: 'sentimentModel',
        } as const;
        expect(values[keyByEnv[envName]]).toBe(expected);
    });

    it.each(['openai', 'anthropic'] as const)(
        'treats blank %s model overrides as absent defaults',
        async (provider) => {
            vi.resetModules();
            vi.stubEnv('AI_RESPONSE_PROVIDER', provider);
            for (const name of [
                'AI_RESPONSE_MODEL',
                'AI_CONFIDENCE_MODEL',
                'AI_CLASSIFIER_MODEL',
                'AI_SENTIMENT_MODEL',
            ])
                vi.stubEnv(name, '   ');
            vi.stubEnv('OPENAI_API_KEY', provider === 'openai' ? 'test-openai' : '');
            vi.stubEnv('ANTHROPIC_API_KEY', provider === 'anthropic' ? 'test-anthropic' : '');
            const { config: values, validateConfig: validate } = await loadConfig();
            expect(() => validate()).not.toThrow();
            const responseExpected = provider === 'openai' ? 'gpt-5.6-luna' : 'claude-sonnet-4-6';
            const auxiliaryExpected =
                provider === 'openai' ? 'gpt-5.6-luna' : 'claude-haiku-4-5-20251001';
            expect(values.responseModel).toBe(responseExpected);
            expect(values.confidenceModel).toBe(auxiliaryExpected);
            expect(values.classifierModel).toBe(auxiliaryExpected);
            expect(values.sentimentModel).toBe(auxiliaryExpected);
        },
    );
});

describe('Pathfinder query cap configuration', () => {
    beforeEach(() => vi.resetModules());
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('defaults to 1000 characters when unset', async () => {
        vi.stubEnv('PATHFINDER_MAX_QUERY_CHARS', undefined);
        expect((await loadConfig()).config.pathfinder.maxQueryChars).toBe(1000);
    });

    it.each(['1', '250', String(Number.MAX_SAFE_INTEGER)])(
        'accepts a positive safe integer cap of %s',
        async (value) => {
            vi.stubEnv('PATHFINDER_MAX_QUERY_CHARS', value);
            expect((await loadConfig()).config.pathfinder.maxQueryChars).toBe(Number(value));
        },
    );

    it.each([
        'invalid',
        '',
        ' ',
        'NaN',
        'Infinity',
        '0',
        '-1',
        '1.5',
        '1000chars',
        String(Number.MAX_SAFE_INTEGER + 1),
    ])('rejects invalid cap %j before Pathfinder can load', async (value) => {
        vi.stubEnv('PATHFINDER_MAX_QUERY_CHARS', value);
        await expect(loadConfig()).rejects.toThrow('PATHFINDER_MAX_QUERY_CHARS');
    });
});

/**
 * AI pipeline configuration.
 *
 * Centralizes all AI-related settings: API keys, model selections,
 * confidence thresholds, and Pathfinder connection params.
 */

import { AI_CONFIDENCE } from '@copilotkit/outpost/shared';

// Validate during config loading so direct Pathfinder clients are protected too.
const maxQueryChars = Number(process.env.PATHFINDER_MAX_QUERY_CHARS ?? '1000');
if (!Number.isSafeInteger(maxQueryChars) || maxQueryChars <= 0) {
    throw new Error('[AI Config] PATHFINDER_MAX_QUERY_CHARS must be a positive safe integer');
}

const auxiliaryDefaultModel =
    process.env.AI_RESPONSE_PROVIDER === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-5.6-luna';

function envValueOrDefault(value: string | undefined, fallback: string): string {
    const normalized = value?.trim();
    return normalized ? normalized : fallback;
}

function isBlank(value: string | undefined): boolean {
    return value === undefined || value.trim().length === 0;
}

export const config = {
    /** Anthropic API key — required for Claude calls */
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',

    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    responseProvider: process.env.AI_RESPONSE_PROVIDER || 'openai',
    draftLintMode: process.env.AI_DRAFT_LINT_MODE || 'report',

    /** Pathfinder MCP server URL */
    pathfinderMcpUrl: process.env.PATHFINDER_MCP_URL || 'https://mcp.copilotkit.ai',

    /** Fallback docs URL when MCP is unavailable */
    fallbackDocsUrl: process.env.FALLBACK_DOCS_URL || 'https://docs.copilotkit.ai/llms-full.txt',

    /** Model used for response generation */
    responseModel: envValueOrDefault(
        process.env.AI_RESPONSE_MODEL,
        process.env.AI_RESPONSE_PROVIDER === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.6-luna',
    ),
    legacyResponseModel: process.env.AI_LEGACY_RESPONSE_MODEL || 'claude-sonnet-4-6',

    /** Model used for confidence scoring (cheaper, faster) */
    confidenceModel: envValueOrDefault(process.env.AI_CONFIDENCE_MODEL, auxiliaryDefaultModel),

    /** Model used for ticket classification (cheaper, faster) */
    classifierModel: envValueOrDefault(process.env.AI_CLASSIFIER_MODEL, auxiliaryDefaultModel),

    /** Maximum tokens for response generation */
    maxResponseTokens: 2048,

    /** Includes reasoning and the complete-draft confidence judgment. */
    maxConfidenceTokens: 4096,

    /** Includes low-effort reasoning and structured classification output. */
    maxClassifierTokens: 2048,

    /** Model used for sentiment analysis (cheap, fast) */
    sentimentModel: envValueOrDefault(process.env.AI_SENTIMENT_MODEL, auxiliaryDefaultModel),

    /** Includes low-effort reasoning and structured sentiment output. */
    maxSentimentTokens: 2048,

    /** Temperature for sentiment analysis */
    sentimentTemperature: 0.1,

    /** Temperature for response generation */
    responseTemperature: 0.3,

    /** Temperature for confidence scoring (lower = more deterministic) */
    confidenceTemperature: 0.1,

    /** Temperature for classification */
    classifierTemperature: 0.1,

    /** Confidence thresholds (sourced from @copilotkit/outpost/shared) */
    confidence: {
        /** Above this: HIGH confidence (auto-post) */
        highThreshold: AI_CONFIDENCE.HIGH_THRESHOLD,
        /** Above this: MEDIUM confidence (post with disclaimer) */
        mediumThreshold: AI_CONFIDENCE.MEDIUM_THRESHOLD,
    },

    /** Pathfinder search settings */
    pathfinder: {
        /** Default number of results to return */
        defaultLimit: 8,
        /** Minimum similarity score to include */
        defaultMinScore: 0.3,
        /** Request timeout in milliseconds */
        requestTimeoutMs: 10_000,
        /** Session TTL in milliseconds (30 minutes) */
        sessionTtlMs: 30 * 60 * 1000,
        /** Reconnect grace period before TTL expiry (5 minutes) */
        refreshBeforeExpiryMs: 5 * 60 * 1000,
        /**
         * Hard cap on the characters sent as an MCP search `query`.
         * Overrides must be positive safe integers; malformed values fail startup.
         *
         * A retrieval query is an embedding input, not a transcript: the issue
         * body still reaches the generator in full, only the SEARCH string is
         * capped. Measured on 7 days of Pathfinder's `query_log`, the longest
         * query from any client that is NOT a relay is 194 characters, while the
         * SEO-spam bodies this relay forwarded verbatim ran 3,304-3,631 — and
         * scored a feeble 0.33-0.43 cosine for it, so the long tail was buying
         * nothing. 1000 leaves ~5x headroom over every observed human query.
         */
        maxQueryChars,
        /**
         * Value sent as `X-Pathfinder-Source` on the MCP `initialize` request.
         *
         * Pathfinder captures this header ONCE, at session initialisation, and
         * closes over it for the session's lifetime — so it must ride on
         * `initialize`, never on an individual `tools/call`. It exists so this
         * relay's traffic is attributable and, more to the point, EXCLUDABLE:
         * every query from here is machine traffic derived from someone else's
         * text, and it should not rank in Top Queries or seed a gap-analysis
         * prompt just because it was loud.
         */
        sourceTag: process.env.PATHFINDER_SOURCE ?? 'outpost',
    },
} as const;

export type AIConfig = typeof config;

/**
 * Validate that required configuration values are present.
 * Throws if any critical config is missing.
 */
export function validateConfig(
    values: Pick<
        AIConfig,
        'anthropicApiKey' | 'openaiApiKey' | 'responseProvider' | 'responseModel' | 'draftLintMode'
    > &
        Partial<Pick<AIConfig, 'confidenceModel' | 'classifierModel' | 'sentimentModel'>> = config,
): void {
    if (values.responseProvider === 'anthropic' && isBlank(values.anthropicApiKey)) {
        throw new Error(
            '[AI Config] ANTHROPIC_API_KEY is required but not set. ' +
                'Set the ANTHROPIC_API_KEY environment variable before starting the pipeline.',
        );
    }
    if (!['openai', 'anthropic'].includes(values.responseProvider))
        throw new Error('[AI Config] AI_RESPONSE_PROVIDER must be openai or anthropic');
    if (values.responseProvider === 'openai' && isBlank(values.openaiApiKey))
        throw new Error('[AI Config] OPENAI_API_KEY is required for the OpenAI support agent');
    for (const [name, model] of [
        ['AI_RESPONSE_MODEL', values.responseModel],
        ['AI_CONFIDENCE_MODEL', values.confidenceModel],
        ['AI_CLASSIFIER_MODEL', values.classifierModel],
        ['AI_SENTIMENT_MODEL', values.sentimentModel],
    ] as const) {
        if (model !== undefined) validateModelProvider(values.responseProvider, model, name);
    }
    if (!['report', 'enforce'].includes(values.draftLintMode))
        throw new Error('[AI Config] AI_DRAFT_LINT_MODE must be report or enforce');
}

/** Reject mismatched overrides instead of silently switching providers. */
export function validateModelProvider(provider: string, model: string, name: string): void {
    if (!['openai', 'anthropic'].includes(provider))
        throw new Error('[AI Config] AI_RESPONSE_PROVIDER must be openai or anthropic');
    const normalizedModel = model.trim();
    if (!normalizedModel) throw new Error(`[AI Config] ${name} must not be blank`);
    if (
        (provider === 'openai' && normalizedModel.startsWith('claude-')) ||
        (provider === 'anthropic' && isKnownOpenAIModel(normalizedModel))
    )
        throw new Error(`[AI Config] ${name} does not match AI_RESPONSE_PROVIDER`);
}

/** Recognize known families without rejecting custom provider deployment names. */
function isKnownOpenAIModel(model: string): boolean {
    return model.startsWith('gpt-') || /^o[134](?:-|$)/.test(model);
}

/**
 * AI pipeline configuration.
 *
 * Centralizes all AI-related settings: API keys, model selections,
 * confidence thresholds, and Pathfinder connection params.
 */

import { AI_CONFIDENCE } from '@copilotkit/outpost/shared';

export const config = {
    /** Anthropic API key — required for Claude calls */
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',

    /** Pathfinder MCP server URL */
    pathfinderMcpUrl: process.env.PATHFINDER_MCP_URL ?? 'https://mcp.copilotkit.ai',

    /** Fallback docs URL when MCP is unavailable */
    fallbackDocsUrl: process.env.FALLBACK_DOCS_URL ?? 'https://docs.copilotkit.ai/llms-full.txt',

    /** Model used for response generation */
    responseModel: process.env.AI_RESPONSE_MODEL ?? 'claude-sonnet-4-6',

    /** Model used for confidence scoring (cheaper, faster) */
    confidenceModel: process.env.AI_CONFIDENCE_MODEL ?? 'claude-haiku-4-5-20251001',

    /** Model used for ticket classification (cheaper, faster) */
    classifierModel: process.env.AI_CLASSIFIER_MODEL ?? 'claude-haiku-4-5-20251001',

    /** Maximum tokens for response generation */
    maxResponseTokens: 2048,

    /** Maximum tokens for confidence scoring */
    maxConfidenceTokens: 256,

    /** Maximum tokens for classification */
    maxClassifierTokens: 512,

    /** Model used to distill a raw message body into a docs-search query (cheap, fast) */
    queryDistillerModel: process.env.AI_QUERY_DISTILLER_MODEL ?? 'claude-haiku-4-5-20251001',

    /** Maximum tokens for query distillation — the output is one short query */
    maxQueryDistillerTokens: 128,

    /** Temperature for query distillation (lower = more deterministic) */
    queryDistillerTemperature: 0,

    /** Model used for sentiment analysis (cheap, fast) */
    sentimentModel: process.env.AI_SENTIMENT_MODEL ?? 'claude-haiku-4-5-20251001',

    /** Maximum tokens for sentiment analysis */
    maxSentimentTokens: 512,

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
    },
} as const;

export type AIConfig = typeof config;

/**
 * Validate that required configuration values are present.
 * Throws if any critical config is missing.
 */
export function validateConfig(): void {
    if (!config.anthropicApiKey) {
        throw new Error(
            '[AI Config] ANTHROPIC_API_KEY is required but not set. ' +
            'Set the ANTHROPIC_API_KEY environment variable before starting the pipeline.',
        );
    }
}

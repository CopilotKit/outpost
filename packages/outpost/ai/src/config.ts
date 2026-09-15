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
        /**
         * Hard cap on the characters sent as an MCP search `query`.
         *
         * A retrieval query is an embedding input, not a transcript: the issue
         * body still reaches the generator in full, only the SEARCH string is
         * capped. Measured on 7 days of Pathfinder's `query_log`, the longest
         * query from any client that is NOT a relay is 194 characters, while the
         * SEO-spam bodies this relay forwarded verbatim ran 3,304-3,631 — and
         * scored a feeble 0.33-0.43 cosine for it, so the long tail was buying
         * nothing. 1000 leaves ~5x headroom over every observed human query.
         */
        maxQueryChars: parseInt(process.env.PATHFINDER_MAX_QUERY_CHARS ?? '1000', 10),
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
export function validateConfig(): void {
    if (!config.anthropicApiKey) {
        throw new Error(
            '[AI Config] ANTHROPIC_API_KEY is required but not set. ' +
                'Set the ANTHROPIC_API_KEY environment variable before starting the pipeline.',
        );
    }
}

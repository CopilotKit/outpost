/**
 * Types for the Outpost AI pipeline.
 */

import { AI_CONFIDENCE, TicketPriority, TicketType } from '@copilotkit/outpost/shared';
import type { PlatformTarget } from '@copilotkit/outpost/shared';
// Type-only import — erased at build time, so the types.ts ↔ groundedness.ts
// cycle never exists at runtime.
import type { GroundednessAssessment } from './groundedness.js';
export { TicketPriority, TicketType } from '@copilotkit/outpost/shared';
export type { PlatformTarget } from '@copilotkit/outpost/shared';

export enum ConfidenceLevel {
    HIGH = 'HIGH',
    MEDIUM = 'MEDIUM',
    LOW = 'LOW',
}

/**
 * Classify a numeric confidence score into a ConfidenceLevel.
 * Single source of truth — used by generator, pipeline, and confidence scorer.
 */
export function classifyConfidence(score: number): ConfidenceLevel {
    if (score >= AI_CONFIDENCE.HIGH_THRESHOLD) return ConfidenceLevel.HIGH;
    if (score >= AI_CONFIDENCE.MEDIUM_THRESHOLD) return ConfidenceLevel.MEDIUM;
    return ConfidenceLevel.LOW;
}

/**
 * Highest score a suppressed (unpublishable) response may carry. Sits just below
 * the escalation gate so a withheld answer always reads as needing a human.
 *
 * Lives here rather than in pipeline.ts because the generator classifies its own
 * `confidenceLevel` against the same clamp — two places must agree on what a
 * withheld response is worth, so they read one constant.
 */
export const SUPPRESSED_CONFIDENCE_CAP = AI_CONFIDENCE.ESCALATE - 0.01;

export interface SearchResult {
    /** Title of the matched document or section */
    title: string;
    /** The matched content snippet */
    content: string;
    /** Relevance score from 0 to 1 */
    score: number;
    /** Source URL if available */
    sourceUrl?: string;
    /** Category of the matched content */
    category?: string;
    /**
     * Whether this came from documentation or from source code.
     *
     * The prompt needs the distinction. GROUNDING_RULES tells the model that code
     * entries are shown with their file path, and that where code and docs
     * disagree the code is what ships — both unusable if a docs page titled
     * `api-reference/components/CopilotKit` and a code hit titled
     * `packages/react-core/src/index.ts` render identically.
     *
     * Optional because the JSON result format and the plain-text fallback carry no
     * such marker; absent means "not known", which the prompt renders as neither.
     */
    kind?: 'docs' | 'code';
}

export interface GeneratedResponse {
    /** The generated response text */
    text: string;
    /**
     * Retrieval-quality confidence from 0 to 1 — how good the sources were, NOT
     * what the response did with them. The groundedness penalty is deliberately
     * absent: see `groundedness` below.
     */
    confidenceScore: number;
    /**
     * Confidence in THIS response, classified from `confidenceScore` after the
     * groundedness penalty is deducted and clamped to SUPPRESSED_CONFIDENCE_CAP
     * when `groundedness.suppress` is set. It therefore reads lower than
     * `classifyConfidence(confidenceScore)` for an ungrounded answer, and can never
     * report HIGH for one the gate would withhold. The deduction is local to the
     * classification — `confidenceScore` is left retrieval-only so the pipeline's
     * `min()` still charges the deterministic penalty exactly once.
     *
     * "Exactly once" is about THIS penalty, not about groundedness overall. The
     * LLM confidence scorer also weighs groundedness (rubric factor 5 in
     * confidence.ts), and its score enters through the same `min()` before this
     * deduction — so an ungrounded answer can be marked down by two independent
     * mechanisms. That is intended as defense in depth, and
     * MAX_GROUNDEDNESS_PENALTY bounds the deterministic half of it.
     */
    confidenceLevel: ConfidenceLevel;
    /** Search results used as context for generation */
    sources: SearchResult[];
    /** Reasoning for the confidence assessment */
    reasoning: string;
    /** Token usage for cost monitoring */
    tokenUsage?: TokenUsage;
    /** End-to-end latency in milliseconds */
    latencyMs?: number;
    /**
     * Groundedness of `text` against `sources`, assessed once here and consumed by
     * the pipeline. The generator does NOT apply the penalty to `confidenceScore`:
     * the pipeline is the single place that deducts, after feedback calibration.
     * Subtracting in both places double-counted it, since `confidenceScore` feeds
     * the pipeline's `min()` before its own deduction.
     */
    groundedness?: GroundednessAssessment;
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
}

export interface PipelineContext {
    /** The user's question or message */
    question: string;
    /** Additional context (ticket history, account info, etc.) */
    context?: string;
    /** The ticket ID this response is for */
    ticketId?: string;
    /** The account domain for targeted search */
    accountDomain?: string;
    /**
     * The channel the question was asked in. Used so the generated response
     * never redirects the user to the channel they're already using
     * (e.g. "join the Discord" to someone already in Discord).
     */
    source?: PlatformTarget;
}

export interface PathfinderQuery {
    /** The search query */
    query: string;
    /** Maximum number of results */
    limit?: number;
    /** Minimum relevance score threshold */
    minScore?: number;
    /** Filter by category */
    category?: string;
}

export interface TicketClassification {
    priority: TicketPriority;
    type: TicketType;
    tags: string[];
    reasoning: string;
}

// ─── Sentiment Types ───────────────────────────────────────────────────────

export enum SentimentLabel {
    POSITIVE = 'POSITIVE',
    NEUTRAL = 'NEUTRAL',
    NEGATIVE = 'NEGATIVE',
    CRITICAL = 'CRITICAL',
}

export interface SentimentResult {
    /** Percentage of negative sentiment (0-100) */
    score: number;
    /** Classified sentiment label */
    label: SentimentLabel;
    /** Token usage for cost monitoring */
    tokenUsage: TokenUsage;
}

// ─── Engagement Types ──────────────────────────────────────────────────────

export enum EngagementLevel {
    HIGH = 'HIGH',
    MEDIUM = 'MEDIUM',
    LOW = 'LOW',
    INACTIVE = 'INACTIVE',
}

export interface AccountMetrics {
    /** Number of messages in the scoring window */
    messageCount: number;
    /** Number of tickets created in the scoring window */
    ticketCount: number;
    /** Average messages per day in the scoring window */
    avgMessagesPerDay: number;
    /** Days since most recent activity */
    daysSinceLastActivity: number;
    /** Percentage of messages that received a reply (0-100) */
    responseRate: number;
    /** Trend in ticket volume: positive = increasing, negative = decreasing */
    ticketVolumeTrend: number;
}

export interface EngagementResult {
    /** Engagement score (0-100) */
    score: number;
    /** Classified engagement level */
    level: EngagementLevel;
}

// ─── Sentiment Trend Types ─────────────────────────────────────────────────

export interface SentimentPeriod {
    /** Start of the period (ISO date string) */
    periodStart: string;
    /** End of the period (ISO date string) */
    periodEnd: string;
    /** Sentiment score for this period */
    score: number;
    /** Sentiment label for this period */
    label: SentimentLabel;
    /** Number of messages analyzed in this period */
    messageCount: number;
}

export interface SentimentTrendResult {
    /** Sentiment over each period */
    periods: SentimentPeriod[];
    /** Overall trend direction: 'IMPROVING' | 'STABLE' | 'DECLINING' */
    trend: 'IMPROVING' | 'STABLE' | 'DECLINING';
    /** Change in score from first to last period (negative = improving, positive = worsening) */
    delta: number;
}

export interface PipelineOptions {
    /** Platform target for response formatting */
    source: PlatformTarget;
    /** Whether to use streaming mode */
    streaming?: boolean;
    /** Conversation history for follow-up questions */
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    /** Maximum output tokens */
    maxTokens?: number;
    /** Bounded confidence adjustment from aggregate 👍/👎 feedback (default 0). */
    confidenceCalibration?: number;
    /**
     * AbortSignal for client disconnect. Threaded through to the model call so
     * an aborted request frees the connection instead of billing a full
     * generation for nobody. Note: aborting an already-dispatched non-streaming
     * request frees capacity but does not guarantee the provider skips the charge.
     */
    signal?: AbortSignal;
}

export interface FormattedResponse {
    /** The formatted response text */
    text: string;
    /** Action buttons metadata (for Discord bot) */
    buttons?: Array<{ label: string; action: string }>;
    /** Whether the response was truncated */
    truncated?: boolean;
    /** Split messages (for Discord 2000-char limit) */
    parts?: string[];
}

export interface PipelineResult {
    /**
     * The model's draft, always — including when `suppressed` is true. Internal
     * only: it is what the human handling an escalation edits from. Never publish
     * it to a user-facing surface; publish `formatted` instead.
     */
    response: string;
    /**
     * The text to publish, formatted for the target platform. Safe by
     * construction: when `suppressed` is true this holds SUPPRESSED_RESPONSE_TEXT
     * rather than the draft, so a consumer that publishes it unconditionally
     * cannot leak an ungrounded answer.
     */
    formatted: FormattedResponse;
    /** Confidence assessment */
    confidenceLevel: ConfidenceLevel;
    /** Confidence score (0-1) */
    confidenceScore: number;
    /** Search results used as context */
    searchResults: SearchResult[];
    /** Token usage across all Claude calls */
    tokenUsage: TokenUsage;
    /** End-to-end latency in milliseconds */
    latencyMs: number;
    /** Deterministic check of the response against its sources. */
    groundedness: GroundednessAssessment;
    /**
     * True when the draft makes a claim we can't stand behind, so `formatted`
     * carries the safe replacement instead of `response`. Mirrors
     * `groundedness.suppress`. This is a SIGNAL, not a gate a consumer must
     * enforce — the pipeline already withheld the text. Read it to escalate to a
     * human, to log, or for analytics; you do not need it to post safely.
     */
    suppressed: boolean;
}

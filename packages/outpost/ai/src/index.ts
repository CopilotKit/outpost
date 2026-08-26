export { PathfinderClient } from './pathfinder.js';
export { ResponseGenerator, GROUNDING_RULES, SYSTEM_PROMPT_PREFIX } from './generator.js';
export { ConfidenceScorer } from './confidence.js';
export type { ConfidenceAssessment } from './confidence.js';
export {
    assessGroundedness,
    extractCopilotKitIdentifiers,
    MAX_GROUNDEDNESS_PENALTY,
    SUPPRESS_AT_UNSOURCED_IDENTIFIERS,
} from './groundedness.js';
export type { GroundednessAssessment } from './groundedness.js';
export { TicketClassifier } from './classifier.js';
export {
    AI_DISCLAIMER,
    AI_DISCLAIMER_ESCALATED,
    AI_DISCLAIMER_REVIEWED,
    ResponseFormatter,
} from './formatter.js';
export { AIPipeline, SUPPRESSED_RESPONSE_TEXT } from './pipeline.js';
export { analyzeSentiment } from './sentiment.js';
export { scoreEngagement } from './engagement.js';
export { getSentimentTrend } from './sentiment-trend.js';
export type { TimestampedMessage, TrendOptions } from './sentiment-trend.js';
export { config } from './config.js';
export type { AIConfig } from './config.js';
export {
    computeCalibrationFactor,
    FEEDBACK_MIN_SAMPLE,
    FEEDBACK_MAX_ADJUSTMENT,
    FEEDBACK_SENSITIVITY,
} from './feedback-calibration.js';
export type { FeedbackTally } from './feedback-calibration.js';
export {
    FrontDoorCategory,
    FRONT_DOOR_CATEGORIES,
    isFrontDoorEligible,
    scoreTopIssue,
    rankTopIssues,
} from './front-door.js';
export type {
    FrontDoorCategoryMeta,
    SurfaceTier,
    BlastRadius,
    Severity,
    ExposureFlags,
    SignalInput,
    TopIssueInput,
    ScoredTopIssue,
} from './front-door.js';
// The rule set, the scorer and the linter are API. HISTORICAL_FAILURES and
// TARGET_SHAPE are not re-exported here because they are test data, not a public
// surface — import them from './eval/harness.js' directly in tests and offline
// runners.
//
// Note what this does NOT do: `tsc` emits per file and `index.ts` imports
// `./eval/harness.js` for `scoreCases`, so `dist/eval/harness.js` still ships
// `HISTORICAL_FAILURES` with its reconstructed replies — a bundle grep for
// `@copilotkitnext` will still hit them. Keeping them out of the build needs the
// fixtures moved outside the compiled graph, which is a separate change; the
// earlier version of this comment claimed a guarantee it did not deliver.
export { checkReply, RULES, HANDOFF_WORD_CAP, MIN_REPLY_WORDS } from './eval/rules.js';
export type { RuleId, RuleResult } from './eval/rules.js';
export { scoreCases, formatReport } from './eval/harness.js';
export { lintDraft, describeVerdict } from './eval/linter.js';
export type { LintMode, LintVerdict } from './eval/linter.js';
export type { EvalCase, CaseScore, EvalReport } from './eval/harness.js';
export * from './types.js';

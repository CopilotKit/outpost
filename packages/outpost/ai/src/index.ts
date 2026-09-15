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
// The rule set, the scorer and the linter are API — the linter consumes the
// first two.
//
// The eval fixtures are not, and are no longer reachable from here: they live in
// `eval/__fixtures__/`, which `ai/tsconfig.json` excludes from the build. Not
// re-exporting them was never sufficient on its own — `tsc` emits per file and
// this module imports `./eval/harness.js`, so while they lived in `harness.ts`
// the reconstructed bad replies shipped in `dist/eval/harness.js` regardless of
// what this entry point declared.
//
// Verified against a built `dist`: no fixture reply text remains. `@copilotkitnext`
// still appears in `dist/eval/rules.js`, and has to — that is the rule which bans
// it. A bundle grep for the dead package name will hit the rule, not a fabricated
// example of it.
export { checkReply, RULES, HANDOFF_WORD_CAP, MIN_REPLY_WORDS } from './eval/rules.js';
export type { RuleId, RuleResult } from './eval/rules.js';
export { scoreCases, formatReport } from './eval/harness.js';
export { lintDraft, describeVerdict } from './eval/linter.js';
export type { LintMode, LintVerdict } from './eval/linter.js';
export type { EvalCase, CaseScore, EvalReport } from './eval/harness.js';
export * from './types.js';

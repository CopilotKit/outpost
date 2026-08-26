/**
 * The draft linter — step 3 of "Fix the Agent's Output".
 *
 * The doc's flowchart hangs on one arrow: *"If the draft breaks a rule, it
 * doesn't get cleaned up and posted — it collapses into the two-sentence
 * version. A short honest reply is always the fallback."* This module is that
 * arrow. It runs the same rules the eval harness scores with — deliberately the
 * same module, so the thing measured and the thing enforced cannot drift — and
 * returns a decision.
 *
 * ## It returns a verdict, not copy
 *
 * `lintDraft` never produces replacement text. The caller substitutes its own,
 * and in the pipeline that is the existing `SUPPRESSED_RESPONSE_TEXT` used by the
 * groundedness gate. That is deliberate: that copy already promises a human
 * follow-up, and #231 records what happens when two layers each add their own
 * promise — the reporter is told twice. One owner for user-facing copy, one
 * promise.
 *
 * ## Report-only by default
 *
 * `mode` defaults to `'report'`, which computes the verdict and changes nothing.
 * Enforcing means a rule that misfires withholds a correct answer from a real
 * person — the same failure direction as the groundedness gate suppressing one,
 * which is the bug #234 was filed for. So the sequence is: run in report mode,
 * read what it would have collapsed against real traffic, then enforce once the
 * false-positive rate is known rather than assumed.
 *
 * A rule that could not be evaluated never collapses a draft. See
 * `RuleResult.applicable` — Pathfinder's plain-text fallback returns results with
 * no `sourceUrl` at all, so a correct answer built from it has nothing it could
 * cite, and enforcing a citation there would collapse every such answer.
 */

import { checkReply } from './rules.js';
import type { RuleId, RuleResult } from './rules.js';
import type { SearchResult } from '../types.js';

export type LintMode = 'report' | 'enforce';

export interface LintVerdict {
    /**
     * Whether the caller should publish the draft.
     *
     * Always true in `'report'` mode, whatever the rules found — reporting is for
     * learning what enforcement would do, so it must not change behaviour.
     */
    publish: boolean;
    /** True when at least one applicable rule failed, regardless of mode. */
    wouldCollapse: boolean;
    /** The applicable rules the draft broke, in rule order. */
    failed: RuleId[];
    /** One line per failure, naming the offending text. */
    reasons: string[];
    /** Every rule's result, for logging and for the eval harness. */
    results: RuleResult[];
    mode: LintMode;
}

/**
 * Judge a draft against the reply rules.
 *
 * `sources` must be the results the draft was generated from — the citation and
 * identifier rules are lookups against them, so passing a different set silently
 * turns the two strictest rules into no-ops.
 */
export function lintDraft(
    reply: string,
    sources: SearchResult[],
    mode: LintMode = 'report',
): LintVerdict {
    const results = checkReply(reply, sources);
    // Gates on `blocksPublish`, not on `passed`. The harness scores the doc's
    // metric — zero invented API names — while the pipeline's groundedness gate
    // suppresses only at two, and a linter that collapsed at one would withhold
    // answers production publishes. See RuleResult.blocksPublish.
    const broken = results.filter((r) => r.applicable && r.blocksPublish);

    return {
        publish: mode === 'report' ? true : broken.length === 0,
        wouldCollapse: broken.length > 0,
        failed: broken.map((r) => r.rule),
        reasons: broken.map((r) => `${r.rule}: ${r.detail}`),
        results,
        mode,
    };
}

/**
 * One log line describing what the linter decided, for report-mode runs.
 *
 * Report mode is only worth anything if somebody can read the outcome, and #197
 * is why this returns a string for the caller to log rather than reaching for a
 * logger itself: nothing in this package has adopted the structured logger, so a
 * caller-owned `console` line is the honest option rather than inventing a
 * second convention here.
 */
export function describeVerdict(verdict: LintVerdict, context: string): string {
    if (!verdict.wouldCollapse) {
        return `[DraftLinter] ${context}: clean (${verdict.mode})`;
    }
    const action = verdict.publish
        ? 'would have collapsed to a handoff, published anyway (report mode)'
        : 'collapsed to a handoff';
    return `[DraftLinter] ${context}: ${action} — ${verdict.reasons.join(' | ')}`;
}

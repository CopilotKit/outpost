/**
 * The reply rules from "Fix the Agent's Output", as code.
 *
 * The doc's own success criteria are deliberately mechanical — *"zero invented
 * API names — this one is mechanically checkable, so any occurrence is a bug,
 * not a judgment call"* — and this module is that check. Nothing here calls a
 * model; every rule is a regex or a set lookup over the reply plus the sources
 * it was generated from.
 *
 * ## Two consumers, one rule set
 *
 * These rules are needed twice, and the whole point of putting them here is that
 * the two uses cannot drift apart:
 *
 * 1. **The eval harness** scores a reply after the fact, to answer "did answer
 *    quality move?" across a fixture set of real threads.
 * 2. **The draft linter** (the doc's step 3) runs the same rules *before* the
 *    reply posts, and a failure collapses the draft into the two-sentence
 *    handoff rather than being cleaned up and published.
 *
 * If the linter and the harness ever disagreed about what "invented API name"
 * means, the score would stop predicting the behaviour. So the harness measures
 * exactly what the linter will enforce.
 *
 * ## What is deliberately NOT here
 *
 * Reply-type classification (Answer / Partial / Route / Silent). That taxonomy
 * does not exist in the code yet, and inferring it from the finished text is
 * guesswork — the reply type is chosen from the *evidence*, before writing, so
 * only the pipeline can report it honestly. Until it does, the rules below score
 * observable properties (does it cite, how long is it) rather than pretending to
 * recover the decision.
 */

import { assessGroundedness } from '../groundedness.js';
import type { SearchResult } from '../types.js';

/**
 * Word cap on a reply that cites nothing.
 *
 * The doc's number. A no-answer is currently ~400 words of hedging and should be
 * one line, so the cap is what makes "nothing found -> two sentences, done"
 * checkable rather than aspirational.
 */
export const HANDOFF_WORD_CAP = 60;

/**
 * Fewest words that can count as a reply at all.
 *
 * Every other rule here is a prohibition, so without this one the score is
 * MAXIMISED by saying nothing: `checkReply('')` passed all of them, and so did
 * `'No.'` and `'Escalating.'`. In the live mode that matters most — an agent
 * regressing toward empty or near-empty replies would show up as the score
 * IMPROVING, in the tool built to catch exactly that.
 *
 * Set against the doc's own floor rather than picked: the shortest acceptable
 * reply is a Route, and a Route is *"two sentences. What we confirmed, if
 * anything, and that a human is picking it up."* The reference handoff in the
 * doc — "Confirmed the manifest/lockfile skew. Routing this to the team —
 * someone will follow up here." — is 15 words, so 8 leaves real headroom while
 * still rejecting a bare acknowledgement.
 *
 * A SILENT reply is not a short reply, it is no reply, and is never scored here.
 */
export const MIN_REPLY_WORDS = 8;

/**
 * Phrases the reply may never contain, each traceable to a case in the doc.
 *
 * Anchored tightly on purpose. A rule that fires on ordinary prose is worse than
 * no rule, because a linter failure collapses the draft into a handoff — so a
 * false positive here costs a reporter a correct answer, which is the same
 * failure direction as the groundedness gate withholding one.
 */
const BANNED_PHRASES: Array<{ pattern: RegExp; why: string }> = [
    // Case D's opener, and the doc's "no praise openers" rule.
    { pattern: /\bgreat question\b/i, why: 'praise opener' },
    {
        pattern: /\bthanks for (?:this|the|your) (?:detailed |thorough |thoughtful )?report\b/i,
        why: 'praise opener',
    },
    { pattern: /\bexcellent (?:question|report|catch)\b/i, why: 'praise opener' },
    // Case D's "What I can't do from here" section, and the rule against the
    // agent performing its own humility.
    { pattern: /\bwhat i (?:can'?t|cannot) do\b/i, why: 'self-commentary about its own limits' },
    {
        pattern: /\bi (?:haven'?t|have not) read the source\b/i,
        why: 'self-commentary about its own limits',
    },
    {
        pattern: /\bi (?:don'?t|do not) have access to\b/i,
        why: 'self-commentary about its own limits',
    },
    // Case C: it claimed it could not read the thread. It can.
    {
        pattern:
            /\bi (?:can'?t|cannot) see (?:other|the other|anyone)[^.]{0,40}\b(?:replies|messages|responses)\b/i,
        why: 'false claim that it cannot see the thread',
    },
    // Case D again: coaching the reporter on how to file better issues.
    {
        pattern: /\bin the future,? please (?:include|provide|attach|add)\b/i,
        why: 'coaching the reporter on how to write issues',
    },
];

/** "Never hedge a name" — a hedge means the name is a guess, so it must go. */
const HEDGED_NAME_PATTERNS: RegExp[] = [
    /\bor the equivalent\b/i,
    /\bor (?:its|the) equivalent\b/i,
    /\bor something similar\b/i,
];

/**
 * The retired package.
 *
 * `@copilotkitnext` was the useAgent-era v2 line and merged into `@copilotkit`
 * v2. Naming it sends a reporter to a package that no longer exists, so the doc
 * makes this an absolute: never mentioned.
 */
const DEAD_PACKAGE = /@copilotkitnext\b/i;

/**
 * The one reply that legitimately names the retired package.
 *
 * "Never mention `@copilotkitnext`" is right as a default and wrong as an
 * absolute: someone importing from it needs to be told what to import instead,
 * and *"you're importing from `@copilotkitnext/react`, which merged into
 * `@copilotkit/react-core` v2 — switch the import"* is the correct answer. Under
 * a flat ban that reply fails, and in the linter it collapses into a handoff —
 * so the one reporter who most needs the migration answer is the only one who
 * cannot get it.
 *
 * The carve-out is narrow: naming the dead package is allowed only when the
 * reply also names a live `@copilotkit/` package, which is what makes it a
 * migration instruction rather than a stray reference.
 */
const LIVE_PACKAGE = /@copilotkit\/[a-z-]+/i;

/**
 * The migration framing that makes naming the dead package legitimate.
 *
 * Requiring only that a live `@copilotkit/` package appear somewhere was too
 * loose: it excused the dead one with no requirement that the two be related,
 * which waved through the exact failure Case B documents. "Install
 * `@copilotkit/react-core` and also add `@copilotkitnext/react` for the newer
 * surface" passed — and naming both packages as if both were current IS
 * version-mixing, so the rule became a no-op on its own worst case.
 */
const MIGRATION_FRAMING =
    /\b(?:merged into|replaced by|moved to|superseded by|switch (?:the )?(?:import|to)|instead of|use .{0,20}instead|no longer (?:exists|published|maintained)|is (?:dead|retired|deprecated))\b/i;

/**
 * True when the reply links a source it was actually given.
 *
 * Checked against the retrieved `sources` rather than against a pattern for
 * "looks like one of our URLs". Under a pattern test the URL was both the
 * citation and the laundering: a reply could write its invented hook name
 * *inside* a `docs.copilotkit.ai` link — `/hooks/useCopilotFabricated` — and
 * satisfy the rule with a page that does not exist. The identifier rule cannot
 * catch that either, because `assessGroundedness` blanks URLs before it looks.
 *
 * Substring rather than equality, so a cited URL may carry an anchor or a query
 * the retrieved one did not (`…/CopilotChat#slots`).
 */
function citesARetrievedSource(reply: string, sources: SearchResult[]): boolean {
    // Scheme and host lowercased on both sides: they are case-insensitive in
    // practice, and models and reporters both echo mixed-case hostnames. A
    // case-sensitive compare withheld a correctly-cited answer.
    const normalise = (text: string) =>
        text.replace(/[a-z]+:\/\/[^/\s]+/gi, (m) => m.toLowerCase());
    const haystack = normalise(reply);

    return sources.some((s) => {
        if (!s.sourceUrl) return false;
        const needle = normalise(s.sourceUrl).replace(/[/#?]+$/, '');
        let from = 0;
        for (;;) {
            const at = haystack.indexOf(needle, from);
            if (at === -1) return false;
            // A bare `includes` accepted anything APPENDED to a retrieved URL, so
            // the laundering simply moved one level deeper: retrieval routinely
            // returns a section or index URL, and
            // `…/reference/hooks/useCopilotFabricated` counted as citing
            // `…/reference`. The character after the match has to end the URL
            // rather than continue its path.
            const next = haystack[at + needle.length];
            if (
                next === undefined ||
                /[\s)\]}.,;"'<>]/.test(next) ||
                next === '#' ||
                next === '?'
            ) {
                return true;
            }
            from = at + 1;
        }
    });
}

export const RULES = [
    'says-something',
    'grounded-identifiers',
    'cites-or-is-a-short-handoff',
    'no-banned-phrases',
    'no-hedged-names',
    'no-dead-package',
] as const;

export type RuleId = (typeof RULES)[number];

export interface RuleResult {
    rule: RuleId;
    passed: boolean;
    /**
     * False when the rule could not be evaluated at all, as opposed to evaluated
     * and passed. A not-applicable rule is never a failure and is never counted
     * in a pass rate.
     *
     * The case that forced the distinction: Pathfinder's plain-text fallback
     * (`textSearch`) sets `sourceUrl: undefined` on every result, so a CORRECT
     * answer built from it has nothing it could possibly cite. Under a flat
     * requirement that answer fails the citation rule forever and — once these
     * rules gate publishing — collapses into a handoff every time the fallback is
     * in play. "Did not cite" and "had nothing citable" are different facts.
     */
    applicable: boolean;
    /**
     * Whether this failure should stop the draft publishing, as opposed to being
     * worth reporting.
     *
     * The two are not the same, and collapsing them made the linter stricter than
     * the pipeline it sits beside. `grounded-identifiers` is the case that forced
     * the split: the doc's success criterion is *zero* invented API names, so one
     * occurrence has to show up in a score — but `groundedness.ts` suppresses only
     * at SUPPRESS_AT_UNSOURCED_IDENTIFIERS = 2, reasoning that "one could be a
     * formatting artifact; two is a pattern of fabrication". Gating a publish at
     * one withholds answers production would publish, which is the
     * false-withholding direction both modules warn about.
     *
     * So the harness scores against `passed` and the linter gates on
     * `blocksPublish`. For every other rule the two agree.
     */
    blocksPublish: boolean;
    /** Why it failed, or why it was not applicable. Empty when it passed. */
    detail: string;
}

function countWords(text: string): number {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Run every rule against one reply. Always returns one result per rule, so a
 * report can distinguish "passed" from "not evaluated".
 *
 * `sources` must be the results the reply was actually generated from — the
 * grounding rule is a lookup against them, so passing a different set silently
 * turns the strictest rule into a no-op.
 */
export function checkReply(reply: string, sources: SearchResult[]): RuleResult[] {
    const words = countWords(reply);
    const cites = citesARetrievedSource(reply, sources);
    // Whether citing was possible at all. See RuleResult.applicable.
    const anySourceHasUrl = sources.some((s) => !!s.sourceUrl);

    // A reply that cites nothing is only acceptable as a short handoff, so the
    // two rules below are the two halves of that single sentence in the doc.
    const isShortEnoughForHandoff = words <= HANDOFF_WORD_CAP;

    const groundedness = assessGroundedness(reply, sources);
    const banned = BANNED_PHRASES.filter(({ pattern }) => pattern.test(reply));
    const hedged = HEDGED_NAME_PATTERNS.filter((pattern) => pattern.test(reply));

    return [
        {
            rule: 'says-something',
            // Metric and gate agree for this rule.
            blocksPublish: !(words >= MIN_REPLY_WORDS),
            applicable: true,
            passed: words >= MIN_REPLY_WORDS,
            detail:
                words >= MIN_REPLY_WORDS
                    ? ''
                    : `${words} words — too short to be a reply; the shortest acceptable one is a two-sentence handoff`,
        },
        {
            rule: 'grounded-identifiers',
            applicable: true,
            // The doc's criterion is ZERO invented API names, so one fails the
            // metric. The publish gate is the pipeline's own threshold, so one does
            // not withhold the answer. See RuleResult.blocksPublish.
            passed: groundedness.unsourcedIdentifiers.length === 0,
            blocksPublish: groundedness.suppress,
            detail: groundedness.unsourcedIdentifiers.length
                ? `names not present in any source: ${groundedness.unsourcedIdentifiers.join(', ')}` +
                  (groundedness.suppress ? '' : ' (below the suppression threshold)')
                : '',
        },
        {
            // One rule, not two. `source-link-or-handoff` and `handoff-is-short`
            // evaluated the identical expression, so they could never disagree —
            // which presented five independent signals as six and double-counted
            // every failure in both the per-rule table and the report.
            rule: 'cites-or-is-a-short-handoff',
            // Metric and gate agree for this rule.
            blocksPublish: !(cites || isShortEnoughForHandoff),
            // Not-applicable ONLY when retrieval returned results that happen to
            // carry no URL — Pathfinder's plain-text fallback, where a correct
            // answer has nothing it could cite.
            //
            // `sources: []` is a different fact and must still fail: a long,
            // uncited reply built on zero retrieval is the doc's Case A, the
            // exact input where the citation requirement matters most. Treating
            // the two the same let that reply publish under enforcement.
            applicable: isShortEnoughForHandoff || sources.length === 0 || anySourceHasUrl,
            passed: cites || isShortEnoughForHandoff,
            detail:
                sources.length > 0 && !anySourceHasUrl && !isShortEnoughForHandoff
                    ? 'not evaluated: retrieval returned results but none carries a URL, so nothing could be cited'
                    : cites || isShortEnoughForHandoff
                      ? ''
                      : `${words} words and no link to a retrieved source, over the ${HANDOFF_WORD_CAP}-word handoff cap; a reply this long has to cite what it came from`,
        },
        {
            rule: 'no-banned-phrases',
            // Metric and gate agree for this rule.
            blocksPublish: !(banned.length === 0),
            applicable: true,
            passed: banned.length === 0,
            detail: banned.map(({ why }) => why).join('; '),
        },
        {
            rule: 'no-hedged-names',
            // Metric and gate agree for this rule.
            blocksPublish: !(hedged.length === 0),
            applicable: true,
            passed: hedged.length === 0,
            detail: hedged.length ? 'hedges an API name, which means it is guessing' : '',
        },
        {
            rule: 'no-dead-package',
            applicable: true,
            passed:
                !DEAD_PACKAGE.test(reply) ||
                (LIVE_PACKAGE.test(reply) && MIGRATION_FRAMING.test(reply)),
            blocksPublish: !(
                !DEAD_PACKAGE.test(reply) ||
                (LIVE_PACKAGE.test(reply) && MIGRATION_FRAMING.test(reply))
            ),
            detail: !DEAD_PACKAGE.test(reply)
                ? ''
                : LIVE_PACKAGE.test(reply)
                  ? 'names @copilotkitnext alongside a live package but not as a migration — reads as if both are current, which is the version-mixing failure'
                  : 'mentions @copilotkitnext without naming the @copilotkit/ package that replaced it',
        },
    ];
}

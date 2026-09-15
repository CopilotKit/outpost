/**
 * Scoring and aggregation for the response-quality eval.
 *
 * `rules.ts` judges one reply. This turns a set of judged replies into the
 * numbers the doc asks for — a per-rule pass rate, and the list of cases that
 * regressed — so "did answer quality move?" has an answer that isn't someone's
 * impression of the last few threads they read.
 *
 * ## How this gets driven
 *
 * `scoreCases` takes replies that were *already produced*. It deliberately does
 * not call the pipeline itself, because the two ways of producing a reply have
 * opposite requirements and only one belongs in CI:
 *
 *   - **Fixed replies** (`__fixtures__/historical-failures.ts`) — deterministic, no
 *     network, no model. Pins the rule set against known-bad output so a rule
 *     cannot silently stop firing. Runs in CI.
 *   - **Live replies** — real Pathfinder retrieval and a real model call, run
 *     offline against real threads. This is the one that answers whether quality
 *     moved, and it cannot be deterministic, so it must not gate a merge.
 *
 * `SHADOW_MODE` gates only the platform post-back (`ai-response.ts:824`) —
 * retrieval and generation run fully either way — so the live mode needs no new
 * safety machinery, just a caller that feeds real threads through
 * `AIPipeline.generateSupportResponse` and hands the text here.
 */

import { checkReply, RULES } from './rules.js';
import type { RuleId, RuleResult } from './rules.js';
import type { SearchResult } from '../types.js';

export interface EvalCase {
    /** Stable id, used to diff one run against another. */
    id: string;
    /** What the reporter asked, for the report's readability. */
    question: string;
    /** The reply under judgement. */
    reply: string;
    /** The sources the reply was generated from — the grounding lookup needs these. */
    sources: SearchResult[];
    /** Where this case came from, so a reader can go check it. */
    provenance: string;
}

export interface CaseScore {
    id: string;
    results: RuleResult[];
    /** Rules this case broke. Empty means it passed everything. */
    failed: RuleId[];
}

export interface EvalReport {
    cases: CaseScore[];
    /** Per rule: how many cases passed out of how many were scored. */
    perRule: Record<RuleId, { passed: number; total: number }>;
    /** Cases that broke nothing. */
    cleanCases: number;
    totalCases: number;
}

export function scoreCases(cases: EvalCase[]): EvalReport {
    // Refuses an empty set rather than reporting one as clean. With no cases,
    // every rule scored `{passed: 0, total: 0}` and `formatReport` printed six
    // `ok` lines because `passed === total` — so a live run whose fixture loading
    // silently produced nothing rendered as a perfect score. Silence
    // indistinguishable from success, in the tool built to detect exactly that.
    if (cases.length === 0) {
        throw new Error(
            'scoreCases received no cases. An empty set cannot be scored — it would ' +
                'report every rule as passing. Check that the fixtures actually loaded.',
        );
    }

    const scored: CaseScore[] = cases.map((c) => {
        const results = checkReply(c.reply, c.sources);
        return {
            id: c.id,
            results,
            // A rule that could not be evaluated is not a failure.
            failed: results.filter((r) => r.applicable && !r.passed).map((r) => r.rule),
        };
    });

    // `total` counts only the cases where the rule could be evaluated, so a rule
    // that was inapplicable everywhere reads as 0/0 rather than as a clean sweep.
    const perRule = Object.fromEntries(
        RULES.map((rule) => {
            const applicable = scored.filter(
                (s) => s.results.find((r) => r.rule === rule)?.applicable,
            );
            return [
                rule,
                {
                    passed: applicable.filter((s) => !s.failed.includes(rule)).length,
                    total: applicable.length,
                },
            ];
        }),
    ) as Record<RuleId, { passed: number; total: number }>;

    return {
        cases: scored,
        perRule,
        cleanCases: scored.filter((s) => s.failed.length === 0).length,
        totalCases: scored.length,
    };
}

/** Human-readable report, for the offline runs where somebody reads the output. */
export function formatReport(report: EvalReport): string {
    const lines = [`${report.cleanCases}/${report.totalCases} cases clean`, ''];
    for (const rule of RULES) {
        const { passed, total } = report.perRule[rule];
        // `n/a` rather than `ok` when nothing exercised the rule — `passed === total`
        // is trivially true at 0/0, which is how an unevaluated rule used to read as
        // a clean sweep.
        const verdict = total === 0 ? 'n/a ' : passed === total ? 'ok  ' : 'FAIL';
        lines.push(`  ${verdict} ${rule}: ${passed}/${total}`);
    }
    const dirty = report.cases.filter((c) => c.failed.length > 0);
    if (dirty.length) {
        lines.push('', 'Failing cases:');
        for (const c of dirty) {
            lines.push(`  ${c.id}`);
            // Filtered on `applicable` as well: a not-applicable rule carries
            // `passed: false`, so without this the report printed `n/a` for a rule
            // two lines above and then listed it as a failure — re-creating in the
            // human-readable output exactly the double-counting removed from
            // `perRule`.
            for (const r of c.results.filter((r) => r.applicable && !r.passed)) {
                lines.push(`    - ${r.rule}: ${r.detail}`);
            }
        }
    }
    return lines.join('\n');
}

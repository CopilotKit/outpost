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
 *   - **Fixed replies** (this file's `HISTORICAL_FAILURES`) — deterministic, no
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

const CHAT_DOCS: SearchResult[] = [
    {
        title: 'CopilotChat',
        content:
            'CopilotChat renders a chat window. Use the `CopilotChat` component with the ' +
            '`instructions` prop. Slots let you replace the input via the `input` prop.',
        score: 0.9,
        sourceUrl: 'https://docs.copilotkit.ai/reference/components/chat/CopilotChat',
    },
];

/**
 * The four failures from the doc's appendix, as replies the rules must catch.
 *
 * **These are reconstructions, not transcripts.** The doc describes each reply's
 * shape and quotes fragments of it; the full original text lives in the linked
 * Discord threads and GitHub issue. Each reply below is assembled from what the
 * doc states about it, and the `provenance` field links the original so anyone
 * can check the reconstruction against the real thing.
 *
 * What that means for what these prove: they pin that the RULE SET catches each
 * documented failure mode. They do not measure the current agent, because they
 * are not its current output. Measuring the agent needs the live mode described
 * at the top of this file, fed with the real threads.
 */
export const HISTORICAL_FAILURES: EvalCase[] = [
    {
        id: 'case-a-deep-agents-subagents',
        question: 'Does Deep Agents support subagents?',
        // The doc: said it had "no specific timeline information", sent them to
        // GitHub to ask, and offered a workaround as a "hypothesis". Subagents
        // work today and one code search returns the proof.
        reply:
            "Great question! I don't have specific timeline information on subagent support " +
            'for Deep Agents. One possibility is that you could work around it by composing ' +
            'agents manually, or the equivalent pattern in your own runtime. ' +
            'I would suggest opening a GitHub discussion so the team can weigh in.',
        sources: [],
        provenance:
            'https://discord.com/channels/1122926057641742418/1535447155735789708(2026-08-08)',
    },
    {
        id: 'case-b-version-mixing',
        question: 'How do I render the delegation in the chat?',
        // The doc: mixed v1 and v2 hooks in one answer and hedged an API name.
        reply:
            'You can hook the render path with `useCopilotFabricatedRender` or the equivalent ' +
            'render hook, and install `@copilotkitnext/react` to get the newer surface.',
        sources: CHAT_DOCS,
        provenance:
            'https://discord.com/channels/1122926057641742418/1313616713647919218/threads/1529599811744043018 (2026-07-22)',
    },
    {
        id: 'case-c-false-capability-claim',
        question: '(maintainer follow-up in thread) Did that fix work for you?',
        // The doc: replied to a maintainer, complimented his community spirit,
        // claimed it could not see other people's replies, asked for a version.
        reply:
            'Thanks for your detailed report and for supporting the community here! ' +
            "I can't see other people's replies in this thread, so I don't have the full " +
            'context. Which version of CopilotKit are you using?',
        sources: CHAT_DOCS,
        provenance:
            'https://discord.com/channels/1122926057641742418/1313616713647919218/threads/1531971013791711342 (2026-08-11)',
    },
    {
        id: 'case-d-five-paragraphs-of-nothing',
        question: '(dependency audit listing two concrete problems)',
        // The doc: praise opener, restated both of the reporter's points, a
        // "What I can't do from here" section, advice on writing better issues.
        reply:
            'Great question, and thanks for this detailed report! To summarise what you have ' +
            'found: first, the manifest and the lockfile disagree about the version. Second, ' +
            'the peer dependency range looks too wide. ' +
            "Here is what I can't do from here: I cannot read the source or run the install " +
            'to confirm either point. In the future, please include the full lockfile diff so ' +
            'this is easier to triage. The team will take it from here. ' +
            // Padded deliberately so the reply clears the handoff cap, which is
            // half of what case D is a fixture FOR. Previously `.repeat(2)` bound
            // to the last literal only, so the reply ended with a stray duplicate
            // sentence rather than the length the comment claimed.
            'Let me know if any of that needs clarifying and someone will pick it up. '.repeat(3),
        sources: CHAT_DOCS,
        provenance: 'https://github.com/CopilotKit/CopilotKit/issues/6423',
    },
];

/**
 * The reply the doc holds up as the target shape, written by a maintainer in
 * case A's own thread: verdict, proof, minimum code, one caveat.
 *
 * Present so the rule set is pinned in both directions. A rule set that only
 * ever fires is as useless as one that never does, and this is the case that
 * catches an over-eager rule before it starts collapsing good answers into
 * handoffs.
 */
export const TARGET_SHAPE: EvalCase = {
    id: 'case-a-maintainer-answer',
    question: 'Does Deep Agents support subagents?',
    reply:
        'Subagents work with Deep Agents today; the docs just do not cover them. Pass them ' +
        'straight to `create_deep_agent`. Deep Agents spawns subagents through its built-in ' +
        '`task` tool, which runs as a nested subgraph, and our LangGraph adapter streams those ' +
        'by default, so the delegation shows up in the chat. Render it by hooking the `task` ' +
        'tool. One caveat: be on a recent Python adapter. ' +
        'https://github.com/CopilotKit/CopilotKit/blob/main/packages/runtime/src/langgraph/agent.ts',
    sources: [
        {
            title: 'langgraph/agent.ts',
            content:
                'create_deep_agent spawns subagents through the built-in task tool, which runs ' +
                'as a nested subgraph. The LangGraph adapter streams subgraph events by default.',
            score: 0.95,
            sourceUrl:
                'https://github.com/CopilotKit/CopilotKit/blob/main/packages/runtime/src/langgraph/agent.ts',
        },
    ],
    provenance:
        "Maintainer reply quoted in the Agent's Output Doc, from the case-a thread (2026-08-08)",
};

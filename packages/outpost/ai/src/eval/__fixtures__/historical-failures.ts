/**
 * The doc's four appendix failures, and the reply it holds up as correct.
 *
 * Test data, and kept out of the compiled build deliberately: `__fixtures__` is
 * excluded in `ai/tsconfig.json`, so these strings do not reach `dist` or the
 * worker image. Not re-exporting them from `index.ts` was not enough on its own
 * — `tsc` emits per file and `index.ts` imports `./eval/harness.js`, so while
 * these lived in `harness.ts` they shipped regardless of the entry point, and a
 * bundle grep for `@copilotkitnext` hit them. Verified against a built `dist`.
 *
 * `harness.ts` no longer imports them for the same reason: a compiled module
 * importing an excluded one would emit a broken build.
 */

import type { SearchResult } from '../../types.js';
import type { EvalCase } from '../harness.js';

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
    {
        id: 'case-e-mcp-headers-self-commentary',
        question:
            'v2 MCP sse servers silently drop the headers auth config — the documented example sends no Authorization header',
        // CopilotKit#6927, posted 2026-09-06T17:40Z, 23 seconds after the issue
        // opened. The reporter had already done the work: a reproduction, the
        // wire-level symptom and a proposed fix. The reply opened by praising the
        // write-up, then spent a paragraph announcing what it had not done, then
        // handed the question back to engineering.
        //
        // Kept as a fixture because it is the failure the narrower
        // `read the source` pattern missed on the verb alone: only the praise
        // opener fired, so the self-positioning paragraph — the part that makes
        // the reply worse than silence — published intact.
        reply:
            '## Thanks for this detailed report\n\n' +
            'This is an exceptionally thorough write-up — the reproduction output, the proposed ' +
            'fix, and the note about test coverage are all exactly what the maintainers need to ' +
            'evaluate this quickly.\n\n' +
            "To be clear about my position: I haven't run this code or inspected the source, so " +
            "I can't confirm the root cause or validate the fix independently. What I can say is " +
            'that the behavior you are describing is consistent with the kind of mismatch that ' +
            'can happen when a parameter type changes shape across SDK versions.\n\n' +
            'Engineering will need to verify the internal behavior and decide on the right fix.',
        sources: [],
        provenance:
            'https://github.com/CopilotKit/CopilotKit/issues/6927#issuecomment — posted 2026-09-06, before #241/#242 merged',
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

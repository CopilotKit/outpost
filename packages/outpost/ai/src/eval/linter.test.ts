import { describe, it, expect } from 'vitest';
import { lintDraft, describeVerdict } from './linter.js';
import type { SearchResult } from '../types.js';

const DOCS: SearchResult[] = [
    {
        title: 'CopilotChat',
        content: 'Use the `CopilotChat` component with the `instructions` prop.',
        score: 0.9,
        sourceUrl: 'https://docs.copilotkit.ai/reference/components/chat/CopilotChat',
    },
];

/** A reply that breaks nothing: grounded, cited, no banned phrasing. */
const GOOD =
    'Use the `CopilotChat` component with the `instructions` prop. ' +
    'https://docs.copilotkit.ai/reference/components/chat/CopilotChat';

/** Case D's shape: praise opener, self-commentary, no citation, over the cap. */
const BAD =
    'Great question! Here is what I cannot do from here: I cannot read the source. ' +
    'To summarise what you have found, the versions disagree. '.repeat(6);

describe('report mode', () => {
    it('is the default, so wiring it in cannot change what publishes', () => {
        expect(lintDraft(BAD, DOCS).mode).toBe('report');
    });

    // The whole point of the mode: learn what enforcement would do to real
    // traffic before letting it withhold anything from a real person.
    it('publishes a failing draft while recording that it would not have', () => {
        const verdict = lintDraft(BAD, DOCS);

        expect(verdict.publish).toBe(true);
        expect(verdict.wouldCollapse).toBe(true);
        expect(verdict.failed).toContain('no-banned-phrases');
    });

    it('publishes a clean draft and says nothing would have collapsed', () => {
        const verdict = lintDraft(GOOD, DOCS);

        expect(verdict.publish).toBe(true);
        expect(verdict.wouldCollapse).toBe(false);
        expect(verdict.failed).toEqual([]);
    });
});

describe('enforce mode', () => {
    it('withholds a failing draft', () => {
        const verdict = lintDraft(BAD, DOCS, 'enforce');

        expect(verdict.publish).toBe(false);
        expect(verdict.wouldCollapse).toBe(true);
    });

    it('publishes a clean draft', () => {
        expect(lintDraft(GOOD, DOCS, 'enforce').publish).toBe(true);
    });

    // A rule that could not be evaluated must never withhold an answer. The live
    // case: Pathfinder's plain-text fallback returns results with no sourceUrl, so
    // a correct answer built from it has nothing it could cite — enforcing a
    // citation there would collapse every such answer.
    it('does not withhold on a rule that could not be evaluated', () => {
        const urlLess: SearchResult[] = [
            { title: 'CopilotChat', content: 'Use the `CopilotChat` component.', score: 0.9 },
        ];
        const long = 'Use the `CopilotChat` component as documented. '.repeat(12);

        const verdict = lintDraft(long, urlLess, 'enforce');

        expect(verdict.failed).not.toContain('cites-or-is-a-short-handoff');
        expect(verdict.publish).toBe(true);
    });

    it('reports every rule either way, so a log line can show the whole picture', () => {
        expect(lintDraft(GOOD, DOCS, 'enforce').results).toHaveLength(6);
    });
});

describe('the reasons', () => {
    it('name the rule and the offending text', () => {
        const verdict = lintDraft('Great question! ' + 'padding word '.repeat(10), DOCS);

        expect(verdict.reasons.join(' ')).toContain('no-banned-phrases');
        expect(verdict.reasons.join(' ')).toContain('praise opener');
    });
});

describe('describeVerdict', () => {
    it('distinguishes a report-mode near-miss from an enforced collapse', () => {
        expect(describeVerdict(lintDraft(BAD, DOCS), 'ticket-1')).toContain(
            'published anyway (report mode)',
        );
        expect(describeVerdict(lintDraft(BAD, DOCS, 'enforce'), 'ticket-1')).toContain(
            'collapsed to a handoff',
        );
    });

    it('stays quiet-but-informative on a clean draft', () => {
        expect(describeVerdict(lintDraft(GOOD, DOCS), 'ticket-1')).toBe(
            '[DraftLinter] ticket-1: clean (report)',
        );
    });
});

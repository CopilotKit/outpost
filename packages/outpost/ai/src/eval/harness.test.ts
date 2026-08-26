import { describe, it, expect } from 'vitest';
import { scoreCases, formatReport, HISTORICAL_FAILURES, TARGET_SHAPE } from './harness.js';
import { RULES } from './rules.js';
import type { SearchResult } from '../types.js';

describe('scoreCases', () => {
    it('reports every rule for every case', () => {
        const report = scoreCases(HISTORICAL_FAILURES);
        expect(report.totalCases).toBe(HISTORICAL_FAILURES.length);
        for (const rule of RULES) {
            expect(report.perRule[rule].total).toBe(HISTORICAL_FAILURES.length);
        }
    });

    it('counts a clean case as clean', () => {
        const report = scoreCases([TARGET_SHAPE]);
        expect(report.cleanCases).toBe(1);
        expect(report.cases[0].failed).toEqual([]);
    });
});

// The point of the golden set: every documented failure has to be caught by at
// least one rule. If a rule regresses, one of these stops failing — and a case
// that stops failing is exactly as alarming as a test that stops passing.
describe('the documented failures are all caught', () => {
    it.each(HISTORICAL_FAILURES.map((c) => [c.id, c] as const))(
        '%s breaks at least one rule',
        (_id, testCase) => {
            const report = scoreCases([testCase]);
            expect(report.cases[0].failed.length).toBeGreaterThan(0);
        },
    );

    // Named individually rather than only in aggregate, so a regression says
    // WHICH failure mode stopped being caught.
    it('catches case A for hedging a name and for citing nothing', () => {
        const failed = scoreCases([HISTORICAL_FAILURES[0]]).cases[0].failed;
        expect(failed).toContain('no-hedged-names');
        expect(failed).toContain('no-banned-phrases');
    });

    it('catches case B for the dead package and the invented name', () => {
        const failed = scoreCases([HISTORICAL_FAILURES[1]]).cases[0].failed;
        expect(failed).toContain('no-dead-package');
        expect(failed).toContain('grounded-identifiers');
    });

    it('catches case C for the false capability claim', () => {
        const failed = scoreCases([HISTORICAL_FAILURES[2]]).cases[0].failed;
        expect(failed).toContain('no-banned-phrases');
    });

    it('catches case D for self-commentary and issue-writing advice', () => {
        const failed = scoreCases([HISTORICAL_FAILURES[3]]).cases[0].failed;
        expect(failed).toContain('no-banned-phrases');
    });
});

// A rule set that fires on everything is as useless as one that never fires, and
// this is the direction that costs a reporter a correct answer.
describe('the target shape passes', () => {
    it('does not flag the maintainer answer the doc holds up as correct', () => {
        const report = scoreCases([TARGET_SHAPE]);
        expect(report.cases[0].failed).toEqual([]);
    });
});

// A live run whose fixture loading silently produced nothing used to render as a
// perfect score: every rule {passed: 0, total: 0}, so `passed === total` printed
// six `ok` lines.
describe('an empty case list', () => {
    it('is refused rather than scored as clean', () => {
        expect(() => scoreCases([])).toThrow(/no cases/i);
    });
});

// A not-applicable rule carries `passed: false`, so an unfiltered failing-cases
// block printed `n/a` for a rule and then listed it as a failure two lines later —
// re-creating the double-counting in the human-readable output.
describe('the report does not list an unevaluated rule as a failure', () => {
    const urlLess: SearchResult[] = [
        { title: 'CopilotChat', content: 'Use the `CopilotChat` component.', score: 0.9 },
    ];
    const report = () =>
        formatReport(
            scoreCases([
                {
                    id: 'c1',
                    question: 'q',
                    reply: 'Great question! ' + 'padding word '.repeat(30),
                    sources: urlLess,
                    provenance: 'test',
                },
            ]),
        );

    it('marks the citation rule n/a in the per-rule table', () => {
        expect(report()).toContain('n/a  cites-or-is-a-short-handoff: 0/0');
    });

    it('does not repeat it under the failing cases', () => {
        const failingBlock = report().split('Failing cases:')[1] ?? '';
        expect(failingBlock).toContain('no-banned-phrases');
        expect(failingBlock).not.toContain('cites-or-is-a-short-handoff');
    });
});

describe('formatReport', () => {
    it('leads with the clean count and names each failing rule', () => {
        const text = formatReport(scoreCases(HISTORICAL_FAILURES));
        expect(text).toContain(`0/${HISTORICAL_FAILURES.length} cases clean`);
        expect(text).toContain('no-dead-package');
        expect(text).toContain('Failing cases:');
    });

    it('says nothing about failing cases when there are none', () => {
        const text = formatReport(scoreCases([TARGET_SHAPE]));
        expect(text).toContain('1/1 cases clean');
        expect(text).not.toContain('Failing cases:');
    });
});

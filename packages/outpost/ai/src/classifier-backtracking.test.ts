/**
 * Runtime-safety regression for `heuristicClassify`'s incident guards.
 *
 * `heuristicClassify` runs synchronously inside the queue worker's `AI_RESPONSE`
 * handler on the raw, uncapped ticket body — only the model call is truncated
 * (`classifier.ts`, `classify`). A guard whose repeated group can consume the same
 * whitespace two ways has a free choice per gap and enumerates 2^gaps partitions before
 * it can report a failure, so a merely comma-heavy body (a pasted log, a quoted CSV)
 * pins a worker CPU for the rest of the job timeout.
 *
 * The pattern these tests pin is structural, not lexical: the fix is that each gap
 * inside a repeated group has exactly one consumer, and the assertion is that work no
 * longer tracks the separator count. Adding vocabulary to the guards is a separate
 * concern and does not affect anything here.
 *
 * Every row runs in a hard-bounded child process. Asserting in-process would not fail —
 * it would hang the whole Vitest run, because the timer that reports a timeout needs
 * the event loop the blocked regex is holding.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { TicketPriority } from './types.js';
import {
    runBoundedHeuristicClassify,
    type BoundedProbeRun,
    type ProbeBody,
} from './test-utils/bounded-heuristic-classify.js';

/**
 * Generous on purpose. The defect is super-exponential in `SEPARATOR_COUNT`, so the gap
 * between pass and fail is many orders of magnitude, not a factor of two — this budget
 * can absorb a slow CI box, a cold `tsx` start and a noisy neighbour without ever
 * getting close to admitting the unfixed implementation.
 */
const BUDGET_MS = 60_000;

/**
 * At the reported growth rate (~4x per two separators; 24 separators took ~1.4s and 26
 * did not finish in 3s) this many separators is on the order of 10^5 seconds of work
 * for the unfixed guard. Large enough that no budget could hide the defect, small
 * enough that the body is an unremarkable 400-character ticket.
 */
const SEPARATOR_COUNT = 40;

/**
 * Each arm of the object-phrase group that could consume a gap two ways. `, ` and ` / `
 * exercise the punctuation arm (which carried whitespace on both sides); ` , and `
 * interleaves the punctuation and coordinator arms, which could hand the same gap to
 * either.
 */
const separatorRuns: Array<{ id: string; separator: string; label: string }> = [
    { id: 'run-comma', separator: ', ', label: 'comma-separated run' },
    { id: 'run-slash', separator: ' / ', label: 'slash-separated run' },
    { id: 'run-comma-and', separator: ' , and ', label: 'comma-and-coordinator run' },
];

const pumped = (separator: string): string =>
    `We haven't seen${separator.repeat(SEPARATOR_COUNT)}our data loss`;

/**
 * Controls. These pin the semantics the guard is supposed to have, on the very shapes
 * the fix touches — separator-joined object phrases — so a "fix" that simply stopped
 * recognising negated incident lists would fail here rather than pass quietly.
 *
 * The negative rows are paired with the same sentence minus its negation. Without that
 * pairing a HIGH row proves nothing: HIGH is also what a body scores when no guard runs
 * at all. The pair can only be satisfied by the guard actually firing on the negation.
 */
const semanticControls: Array<{ id: string; body: string; priority: TicketPriority }> = [
    // Negative: an absence report, so no CRITICAL floor. One row per separator arm.
    {
        id: 'negative-comma',
        body: "We haven't seen any customer reports, evidence, or data loss.",
        priority: TicketPriority.HIGH,
    },
    {
        id: 'negative-slash',
        body: 'We have not observed any reports / evidence / data loss.',
        priority: TicketPriority.HIGH,
    },
    {
        id: 'negative-and',
        body: 'We have not found any evidence of data loss and production outages.',
        priority: TicketPriority.HIGH,
    },
    {
        id: 'negative-spaced-comma',
        body: "We haven't seen any reports , evidence , or data loss .",
        priority: TicketPriority.HIGH,
    },
    // The same four with the negation removed: each is a report, so the floor stands.
    {
        id: 'affirmed-comma',
        body: 'We have seen any customer reports, evidence, or data loss.',
        priority: TicketPriority.CRITICAL,
    },
    {
        id: 'affirmed-slash',
        body: 'We have observed any reports / evidence / data loss.',
        priority: TicketPriority.CRITICAL,
    },
    {
        id: 'affirmed-and',
        body: 'We have found any evidence of data loss and production outages.',
        priority: TicketPriority.CRITICAL,
    },
    {
        id: 'affirmed-spaced-comma',
        body: 'We have seen any reports , evidence , or data loss .',
        priority: TicketPriority.CRITICAL,
    },
    // Affirmative: a report, so the CRITICAL floor stands. The separator run is present
    // in the body but does not sit between the negation and the incident.
    {
        id: 'affirmative-plain',
        body: 'We are seeing data loss in production right now.',
        priority: TicketPriority.CRITICAL,
    },
    {
        id: 'affirmative-after-run',
        body: "We haven't seen, , , , , our alerts fire, but data loss occurred overnight.",
        priority: TicketPriority.CRITICAL,
    },
    {
        id: 'affirmative-unnegated-object',
        body: 'We have not found the data loss root cause.',
        priority: TicketPriority.CRITICAL,
    },
];

describe('heuristicClassify incident guards — unbounded-work regression', () => {
    let run: BoundedProbeRun;

    beforeAll(async () => {
        const bodies: ProbeBody[] = [
            // Controls first. They finish in milliseconds either way, so when a pumped
            // row does not finish, their presence in the result file proves the child
            // started and ran — the failure is the guard, not the harness.
            ...semanticControls.map(({ id, body }) => ({ id, body })),
            ...separatorRuns.map(({ id, separator }) => ({ id, body: pumped(separator) })),
        ];
        run = await runBoundedHeuristicClassify(bodies, BUDGET_MS);
    }, BUDGET_MS + 30_000);

    it('starts the probe child cleanly', () => {
        expect(run.stderr).toBe('');
        expect(run.completed.size).toBeGreaterThan(0);
    });

    it.each(semanticControls)('classifies the $id control as $priority', ({ id, priority }) => {
        expect(run.completed.get(id)?.priority).toBe(priority);
    });

    it.each(separatorRuns)(
        `finishes a $label of ${SEPARATOR_COUNT} separators the guards cannot accept`,
        ({ id, label }) => {
            expect(
                run.completed.has(id),
                `heuristicClassify did not finish a ${label} of ${SEPARATOR_COUNT} separators ` +
                    `within ${BUDGET_MS}ms (timedOut=${run.timedOut}). A repeated group is ` +
                    `consuming the same whitespace more than one way.`,
            ).toBe(true);
        },
    );

    it('keeps the CRITICAL floor on the pumped bodies', () => {
        // The pumped bodies still end in "our data loss", which no guard cancels, so
        // finishing quickly must not have come from dropping the incident.
        for (const { id } of separatorRuns) {
            expect(run.completed.get(id)?.priority).toBe(TicketPriority.CRITICAL);
        }
    });

    it('does not report the run as timed out', () => {
        expect(run.timedOut).toBe(false);
    });
});

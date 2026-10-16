/**
 * Runs `heuristicClassify` over a set of ticket bodies in a separate, hard-bounded
 * process.
 *
 * `heuristicClassify` is synchronous, so a body that makes it do unbounded work pins
 * the thread it runs on. In-process that is unrecoverable: Vitest's own `testTimeout`
 * is a timer, the timer needs the event loop, and the event loop is exactly what is
 * blocked — the run hangs instead of failing. Running the call in a child the test can
 * SIGKILL is what turns "this never finishes" into an ordinary assertion failure.
 *
 * The budget is a liveness bound, not a benchmark. Callers assert that a body
 * *completed at all* within a generous allowance, never how long it took, so the check
 * does not depend on machine speed or CI load. The failure it is built to catch is
 * super-exponential in the input, which no plausible budget can absorb.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProbeBody, ProbeResult } from './bounded-heuristic-classify.child.js';

export type { ProbeBody, ProbeResult };

const here = path.dirname(fileURLToPath(import.meta.url));
/** `ai/src/test-utils` → `packages/outpost`; the package root `tsx` resolves from. */
const packageRoot = path.resolve(here, '../../..');
const childEntry = path.join(here, 'bounded-heuristic-classify.child.ts');
const childTsconfig = path.join(here, 'bounded-heuristic-classify.tsconfig.json');

export interface BoundedProbeRun {
    /** Results for the bodies that finished, keyed by id. Missing id ⇒ did not finish. */
    completed: Map<string, ProbeResult>;
    /** True when the child was killed because it outlived the budget. */
    timedOut: boolean;
    /** Anything the child wrote to stderr — carries the stack when it throws. */
    stderr: string;
}

/**
 * Classify `bodies` in order in a child process, killing it after `budgetMs`.
 *
 * Resolves rather than rejects on timeout: the partial result set is the evidence a
 * caller needs, so it is returned instead of thrown away.
 */
export async function runBoundedHeuristicClassify(
    bodies: ProbeBody[],
    budgetMs: number,
): Promise<BoundedProbeRun> {
    const dir = mkdtempSync(path.join(tmpdir(), 'outpost-bounded-classify-'));
    const resultPath = path.join(dir, 'results.ndjson');
    writeFileSync(resultPath, '');

    try {
        const { timedOut, stderr } = await new Promise<{ timedOut: boolean; stderr: string }>(
            (resolve) => {
                const child = spawn(
                    process.execPath,
                    ['--import', 'tsx', childEntry, resultPath, JSON.stringify(bodies)],
                    {
                        cwd: packageRoot,
                        // tsx otherwise discovers ai/tsconfig.json, whose `paths` point at
                        // `shared/dist` — a build this probe deliberately does not require.
                        env: { ...process.env, TSX_TSCONFIG_PATH: childTsconfig },
                        stdio: ['ignore', 'ignore', 'pipe'],
                    },
                );
                let captured = '';
                child.stderr.setEncoding('utf8');
                child.stderr.on('data', (chunk: string) => {
                    captured += chunk;
                });
                // SIGKILL, not SIGTERM: a thread stuck inside a regex never reaches a
                // JavaScript signal handler, so a catchable signal would be ignored.
                const timer = setTimeout(() => child.kill('SIGKILL'), budgetMs);
                timer.unref();
                child.on('error', (error) => {
                    clearTimeout(timer);
                    resolve({ timedOut: false, stderr: `${captured}\n${error.message}` });
                });
                child.on('close', (_code, signal) => {
                    clearTimeout(timer);
                    resolve({ timedOut: signal === 'SIGKILL', stderr: captured });
                });
            },
        );

        const completed = new Map<string, ProbeResult>();
        for (const line of readFileSync(resultPath, 'utf8').split('\n')) {
            if (line.trim() === '') continue;
            const row = JSON.parse(line) as ProbeResult;
            completed.set(row.id, row);
        }
        return { completed, timedOut, stderr };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

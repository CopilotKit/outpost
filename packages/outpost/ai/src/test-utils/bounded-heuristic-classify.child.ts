/**
 * Child entry point for `./bounded-heuristic-classify.ts`. Runs
 * `TicketClassifier.prototype.heuristicClassify` on each supplied body and appends one
 * NDJSON result line per body to the result file named in argv.
 *
 * Results go to a file, appended synchronously, rather than to stdout. That is
 * load-bearing: this loop is fully synchronous, so a body that pins the event loop
 * would leave every earlier `process.stdout.write` sitting unflushed in a userland
 * queue and lose it when the parent kills the process. Appending per body means the
 * lines already on disk tell the parent exactly which bodies completed and which one
 * the process was still inside — the difference between a useful failure and "timed
 * out".
 *
 * The method is invoked off the prototype against a bare object rather than through
 * `new TicketClassifier()`: the constructor builds an `AuxiliaryModel`, which validates
 * provider configuration and would make this probe depend on env that has nothing to do
 * with what it measures. `heuristicClassify` reads no instance state.
 */
import { appendFileSync } from 'node:fs';
import { TicketClassifier } from '../classifier.js';

export interface ProbeBody {
    id: string;
    body: string;
}

export interface ProbeResult {
    id: string;
    priority: string;
    type: string;
}

const resultPath = process.argv[2];
if (resultPath === undefined) throw new Error('bounded probe: result path argument is required');
const bodies: ProbeBody[] = JSON.parse(process.argv[3] ?? '[]');

const heuristicClassify = TicketClassifier.prototype.heuristicClassify;
const context = Object.create(TicketClassifier.prototype) as TicketClassifier;

for (const { id, body } of bodies) {
    const result = heuristicClassify.call(context, body);
    const line: ProbeResult = { id, priority: result.priority, type: result.type };
    appendFileSync(resultPath, `${JSON.stringify(line)}\n`);
}

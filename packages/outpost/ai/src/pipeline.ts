import type {
    PipelineContext,
    PipelineOptions,
    PipelineResult,
    TicketClassification,
    TokenUsage,
    SearchResult,
} from './types.js';
import { ConfidenceLevel, SUPPRESSED_CONFIDENCE_CAP, classifyConfidence } from './types.js';
import { assessGroundedness } from './groundedness.js';
import { AI_CONFIDENCE } from '@copilotkit/outpost/shared';
import { PathfinderClient } from './pathfinder.js';
import { ResponseGenerator } from './generator.js';
import { ConfidenceScorer } from './confidence.js';
import { TicketClassifier } from './classifier.js';
import {
    AI_DISCLAIMER,
    AI_DISCLAIMER_ESCALATED,
    AI_DISCLAIMER_REVIEWED,
    ResponseFormatter,
} from './formatter.js';
import { config, validateConfig } from './config.js';

/**
 * The text published in place of a suppressed draft.
 *
 * The groundedness gate lives HERE, at the boundary where the response is
 * produced, not at each consumer. When `groundedness.suppress` is true the
 * pipeline swaps this copy into `formatted`, so every consumer — the queue
 * handler, the web QA route, anything added later — publishes safe text without
 * having to know the gate exists. The model's draft is still returned on
 * `PipelineResult.response` for the human picking up the escalation.
 *
 * The copy promises a human follow-up itself, which is why callers pair it with
 * the plain `AI_DISCLAIMER` rather than `AI_DISCLAIMER_ESCALATED` — stacking
 * both would promise the same follow-up twice.
 */
export const SUPPRESSED_RESPONSE_TEXT =
    "I couldn't find an answer to this in the CopilotKit or AG-UI documentation or source code, so I don't want to guess. I've escalated this to our team — someone will follow up in this thread.";

/**
 * Highest confidence score that still classifies BELOW HIGH. A degraded
 * confidence signal is clamped to this so it keeps its disclaimer and is never
 * treated as authoritative. Tied to the classifyConfidence bands — keep it just
 * under AI_CONFIDENCE.HIGH_THRESHOLD if those bands are ever re-tuned.
 */
const DEGRADED_CONFIDENCE_CAP = AI_CONFIDENCE.HIGH_THRESHOLD - 0.01;

/**
 * Merge two rank-ordered result lists, alternating between them, `first` leading.
 *
 * Concatenating would let a weak hit from the leading list outrank a strong hit
 * from the other purely by which source it came from, and the merged list is
 * capped before it reaches the prompt — so the file that actually answers the
 * question could fall off the end while loosely-related pages stayed.
 * Alternating keeps each source's best material near the front, which is what
 * the context window sees.
 *
 * Not a score merge: the two tools score on different scales (docs carry real
 * relevance numbers, code snippets get a synthesized descending rank), so
 * comparing the numbers across sources would be meaningless. That is also why
 * order is decided by policy — source first — rather than by the numbers.
 */
function interleaveByRank(first: SearchResult[], second: SearchResult[]): SearchResult[] {
    const merged: SearchResult[] = [];
    for (let i = 0; i < Math.max(first.length, second.length); i++) {
        if (i < first.length) merged.push(first[i]);
        if (i < second.length) merged.push(second[i]);
    }
    return merged;
}

/**
 * Main entry point for the Outpost AI pipeline.
 *
 * Orchestrates: Pathfinder retrieval → Claude response generation → confidence
 * scoring (against the real generated response) → response formatting. Every
 * step has error handling — the pipeline never crashes, always returns a
 * graceful fallback.
 *
 * The groundedness gate is enforced HERE, not by consumers. Both entry points
 * withhold an ungrounded draft themselves: `generateSupportResponse` swaps
 * SUPPRESSED_RESPONSE_TEXT into `formatted`, and `generateStreamingResponse`
 * buffers before yielding so it can do the same. Publishing what the pipeline
 * hands back is therefore always safe — a consumer never has to read
 * `suppressed` to avoid posting a fabrication. `suppressed` and `groundedness`
 * remain on the result for analytics and escalation routing.
 */
export class AIPipeline {
    private pathfinder: PathfinderClient;
    private generator: ResponseGenerator;
    private confidenceScorer: ConfidenceScorer;
    private classifier: TicketClassifier;
    private formatter: ResponseFormatter;

    constructor(options?: {
        pathfinder?: PathfinderClient;
        generator?: ResponseGenerator;
        confidenceScorer?: ConfidenceScorer;
        classifier?: TicketClassifier;
        formatter?: ResponseFormatter;
    }) {
        validateConfig();
        this.pathfinder = options?.pathfinder ?? new PathfinderClient();
        this.generator = options?.generator ?? new ResponseGenerator();
        this.confidenceScorer = options?.confidenceScorer ?? new ConfidenceScorer();
        this.classifier = options?.classifier ?? new TicketClassifier();
        this.formatter = options?.formatter ?? new ResponseFormatter();
    }

    /**
     * Generate a complete support response: retrieval → generation → scoring → formatting.
     *
     * Steps 2 (response generation) and 3 (confidence scoring) run sequentially —
     * scoring needs the real generated text, not a placeholder.
     */
    async generateSupportResponse(
        question: string,
        options: PipelineOptions,
    ): Promise<PipelineResult> {
        const startTime = Date.now();
        const totalTokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

        // Step 1: Query Pathfinder for relevant content — docs AND source.
        //
        // Source first, docs second, per the decision in the Agent's Output Doc:
        // we ship fast, so the code is the truth and the docs are the lagging
        // indicator. Until this, only `searchDocs` ran, so any question whose
        // answer lived in the source had nothing behind it and the answer came
        // from general framework priors. That is how a reporter asking whether
        // Deep Agents supports subagents got told there was no timeline for a
        // feature that already shipped.
        //
        // Run in parallel and merge rather than sequentially: they are
        // independent queries against the same server, and a docs-only latency
        // budget is the one we already live with.
        //
        // Each tool gets half the budget and the merged list is still capped, so
        // the prompt carries what it always did. Without either, it would have
        // carried up to 2x the sources — and code snippets are line-numbered file
        // excerpts far larger than doc snippets, so input tokens per ticket
        // roughly doubled, with a real path to a context-length error that lands
        // in the generator's catch and publishes the apology fallback.
        //
        // AG-UI is deliberately NOT queried here. `searchAgUiDocs` and
        // `searchAgUiCode` exist on the client, but firing them on every
        // CopilotKit question buys noise and spend with no way to tell when they
        // are relevant. Choosing the retrieval strategy from the kind of question
        // asked is the doc's step 5, and it needs the classifier's answer.
        // allSettled, not all: `Promise.all` rejects on the first failure, so one
        // retrieval throwing threw away the other one's results and the answer was
        // built from nothing. Whichever source survives is worth more than
        // symmetry.
        // Split the budget across the two tools instead of asking each for a full
        // `defaultLimit` and discarding half. Over-fetching paid for 16 snippets to
        // keep 8, and it also cost docs recall on the majority path: a purely
        // docs-answerable question used to get 8 docs snippets and would have got
        // 4, with the other 4 going to code hits that merely cleared min_score.
        const perTool = Math.ceil(config.pathfinder.defaultLimit / 2);
        const [docsOutcome, codeOutcome] = await Promise.allSettled([
            this.pathfinder.searchDocs({ query: question, limit: perTool }),
            this.pathfinder.searchCode({ query: question, limit: perTool }),
        ]);
        for (const [label, outcome] of [
            ['searchDocs', docsOutcome],
            ['searchCode', codeOutcome],
        ] as const) {
            if (outcome.status === 'rejected') {
                console.error(
                    `[Pipeline] ${label} failed: ${
                        outcome.reason instanceof Error
                            ? outcome.reason.message
                            : String(outcome.reason)
                    }`,
                );
            }
        }
        // Coerced rather than trusted. This class's contract is that it never
        // crashes, and `Promise.allSettled` reports a non-promise or an
        // `undefined` return as *fulfilled* — so a client that answers with
        // anything other than an array would reach the merge and throw on
        // `.length`, taking down the one code path that is supposed to always
        // produce an answer. The old `try`/`catch` hid this; removing it made it
        // reachable, which is a good reason to handle it rather than re-wrap.
        const asResults = (outcome: PromiseSettledResult<SearchResult[]>): SearchResult[] =>
            outcome.status === 'fulfilled' && Array.isArray(outcome.value) ? outcome.value : [];
        const docs = asResults(docsOutcome);
        const code = asResults(codeOutcome);

        // Code leads, because the stated precedence is source first, docs second.
        // Interleaved rather than concatenated so neither source is buried: the
        // list is capped just below, and docs-then-code would let weak docs hits
        // push the file that actually answers the question off the end.
        const searchResults = interleaveByRank(code, docs).slice(
            0,
            config.pathfinder.defaultLimit,
        );

        // Step 2: Generate response
        const pipelineContext: PipelineContext = {
            question,
            source: options.source,
        };

        const generatedResponse = await this.generator.generate(
            pipelineContext,
            searchResults,
            options.conversationHistory,
            options.signal,
        );

        // Step 3: Score confidence against the ACTUAL generated response
        // (sequential, not parallel — the scorer needs the real text to
        // produce a meaningful signal, not a retrieval-quality proxy).
        const confidenceAssessment = await this.confidenceScorer
            .score(question, generatedResponse.text, searchResults)
            .catch((error) => {
                console.error(
                    `[Pipeline] Confidence scoring failed: ${error instanceof Error ? error.message : String(error)}`,
                );
                // The LLM scorer is unavailable — the heuristic fallback scores off
                // Pathfinder's synthetic rank-scores (not real relevance), so it is an
                // UNCERTAIN signal. Mark it degraded so it can't be trusted as HIGH below.
                return { ...this.confidenceScorer.heuristicScore(searchResults), degraded: true };
            });

        // Aggregate token usage
        if (generatedResponse.tokenUsage) {
            totalTokenUsage.inputTokens += generatedResponse.tokenUsage.inputTokens;
            totalTokenUsage.outputTokens += generatedResponse.tokenUsage.outputTokens;
        }
        totalTokenUsage.inputTokens += confidenceAssessment.tokenUsage.inputTokens;
        totalTokenUsage.outputTokens += confidenceAssessment.tokenUsage.outputTokens;

        // Use the more conservative confidence (lower of generator's and scorer's),
        // then apply the aggregate-feedback calibration (default 0 = no change).
        const combinedConfidenceScore = Math.min(
            generatedResponse.confidenceScore,
            confidenceAssessment.score,
        );
        const calibration = options.confidenceCalibration ?? 0;
        let finalConfidenceScore = Math.max(
            0,
            Math.min(1, combinedConfidenceScore + calibration),
        );

        // Groundedness is deducted AFTER calibration so aggregate 👍/👎 feedback can
        // never offset a fabrication: feedback tunes how we weigh a well-formed
        // answer, it does not license an unsupported claim.
        //
        // This is the ONLY place the penalty is applied. The generator assesses
        // groundedness (it has the response and its sources in hand) and passes the
        // result through untouched — it must not deduct from its own
        // `confidenceScore`, because that score feeds the `min()` above and the
        // penalty would land twice. Recomputed here only if a caller injected a
        // generator that doesn't supply one.
        const groundedness =
            generatedResponse.groundedness ??
            assessGroundedness(generatedResponse.text, searchResults);
        if (groundedness.penalty > 0) {
            finalConfidenceScore = Math.max(0, finalConfidenceScore - groundedness.penalty);
            console.warn(
                `[Pipeline] Groundedness penalty ${groundedness.penalty.toFixed(2)} — ${groundedness.reasons.join('; ')}`,
            );
        }

        // A response we won't publish is not a confident one, whatever the
        // retrieval scored. Clamp below the escalation gate so every downstream
        // reader agrees: the disclaimer promises a human, the dashboard buckets it
        // LOW, and the worker's score-based escalation fires on its own. The
        // capped penalty alone can't guarantee this — a top score plus positive
        // calibration lands exactly ON the gate, which does not escalate.
        // Two independent reasons to guarantee a human sees this, both clamping to
        // the same cap:
        //
        // 1. `suppress` — the response named identifiers no source contains, so the
        //    draft is withheld and the reporter gets the no-answer copy instead.
        // 2. `forcesEscalation` — the response asserted that WE verified something
        //    (confirmed a bug, established a root cause, reproduced it). That text
        //    still publishes; claim wording is fallible English and must never gate
        //    publication. But somebody checks it.
        //
        // The penalty alone cannot guarantee either. The deduction is capped at
        // MAX_GROUNDEDNESS_PENALTY (0.6), so a perfect base score plus the maximum
        // positive feedback calibration lands on exactly 1.0 - 0.6 = ESCALATE, and
        // the escalation gate tests `< ESCALATE` — the worst case would post with a
        // "we'll review it" disclaimer and page nobody.
        //
        // `forcesEscalation` is deliberately narrower than `unverifiedClaims.length
        // > 0`: "this is a known issue, fixed in 1.9.2" and "the fix is to pass the
        // `input` prop" are ordinary sentences in a correct docs-grounded answer.
        // They are priced, not escalated. See ESCALATION_FORCING_CATEGORIES.
        if (groundedness.suppress || groundedness.forcesEscalation) {
            finalConfidenceScore = Math.min(finalConfidenceScore, SUPPRESSED_CONFIDENCE_CAP);
        }

        // Safety cap: a DEGRADED confidence signal (LLM scorer unavailable → heuristic
        // fallback over Pathfinder's synthetic rank-scores) must never present as HIGH.
        // HIGH suppresses the disclaimer and is treated as authoritative, so an ungrounded
        // answer scored high by the heuristic would post with no caveat. Cap to the highest
        // score that still classifies below HIGH so the response keeps a disclaimer. This
        // only ever LOWERS the score — a genuinely low degraded signal is left untouched and
        // still falls through to escalation.
        if (
            confidenceAssessment.degraded &&
            finalConfidenceScore >= AI_CONFIDENCE.HIGH_THRESHOLD
        ) {
            finalConfidenceScore = DEGRADED_CONFIDENCE_CAP;
        }
        const finalConfidence = classifyConfidence(finalConfidenceScore);

        // Step 4: Format for target platform.
        //
        // THE GATE. A suppressed draft never reaches `formatted`, so the withheld
        // text cannot leak through any consumer — publishing `formatted` is
        // always safe by construction. `response` below still carries the draft
        // for the human handling the escalation.
        const publishedText = groundedness.suppress
            ? SUPPRESSED_RESPONSE_TEXT
            : generatedResponse.text;

        // The "we've escalated this" copy must be gated on the SAME condition the
        // worker uses to actually enqueue the ESCALATION job — score < ESCALATE
        // (see queue handlers/ai-response.ts) — NOT on the LOW *level* (score <
        // MEDIUM_THRESHOLD). Otherwise a score in [ESCALATE, MEDIUM_THRESHOLD)
        // is LOW but never escalated, so the reporter is promised a follow-up
        // that never comes.
        //
        // A suppressed response is the exception: SUPPRESSED_RESPONSE_TEXT already
        // promises the same follow-up, so it takes the plain sentence instead of
        // saying it twice.
        //
        // No variant may hedge about the response's completeness — see the
        // AI_DISCLAIMER doc comment in formatter.ts.
        const needsDisclaimer = finalConfidence !== ConfidenceLevel.HIGH;
        const willEscalate = finalConfidenceScore < AI_CONFIDENCE.ESCALATE;
        const disclaimerText = groundedness.suppress
            ? AI_DISCLAIMER
            : willEscalate
              ? AI_DISCLAIMER_ESCALATED
              : AI_DISCLAIMER_REVIEWED;

        const formatted = this.formatter.format(publishedText, options.source, {
            addDisclaimer: needsDisclaimer,
            disclaimerText,
        });

        const latencyMs = Date.now() - startTime;

        if (groundedness.suppress) {
            console.warn(
                `[Pipeline] Response withheld from public post — ${groundedness.reasons.join('; ')}`,
            );
        }

        return {
            // The ORIGINAL draft, even when suppressed — the human picking up the
            // escalation works from it. Never publish this; publish `formatted`.
            response: generatedResponse.text,
            formatted,
            confidenceLevel: finalConfidence,
            confidenceScore: finalConfidenceScore,
            searchResults,
            tokenUsage: totalTokenUsage,
            latencyMs,
            groundedness,
            suppressed: groundedness.suppress,
        };
    }

    /**
     * Classify a ticket based on its content.
     */
    async classifyTicket(
        content: string,
    ): Promise<TicketClassification & { tokenUsage: TokenUsage }> {
        try {
            return await this.classifier.classify(content);
        } catch (error) {
            console.error(
                `[Pipeline] Classification failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return {
                ...this.classifier.heuristicClassify(content),
                tokenUsage: { inputTokens: 0, outputTokens: 0 },
            };
        }
    }

    /**
     * Generate a response as a chunk stream, gated on groundedness.
     *
     * NOT incremental. The groundedness gate is a property of the WHOLE response
     * — you cannot know a draft invents an identifier until you have read it to
     * the end — so this method drains the model stream into a buffer, assesses it,
     * and only then yields. Consumers get the same chunk boundaries the model
     * produced, but they get them after generation completes: time-to-first-token
     * equals total latency.
     *
     * That is the deliberate tradeoff. The alternative — yielding chunks as they
     * arrive — cannot be gated at all: text already written to the wire cannot be
     * withheld, and this entry point would be the one ungated way to reach a
     * public thread. Callers that genuinely need incremental delivery must not use
     * a gated pipeline; callers that want the metadata (confidence, sources,
     * suppression) should use {@link generateSupportResponse} directly.
     *
     * When the draft is suppressed, the ONLY thing yielded is
     * {@link SUPPRESSED_RESPONSE_TEXT} — the draft is discarded, not returned, on
     * this path. Use `generateSupportResponse` if you need the draft.
     */
    async *generateStreamingResponse(
        question: string,
        options: PipelineOptions,
    ): AsyncIterable<string> {
        // Fetch search results first
        let searchResults: SearchResult[];
        try {
            searchResults = await this.pathfinder.searchDocs({
                query: question,
            });
        } catch (error) {
            console.error(
                `[Pipeline] Streaming search failed: ${error instanceof Error ? error.message : String(error)}`,
                error,
            );
            searchResults = [];
        }

        const pipelineContext: PipelineContext = {
            question,
            source: options.source,
        };

        // Buffer the whole draft — the gate needs the complete text.
        const chunks: string[] = [];
        for await (const chunk of this.generator.generateStream(
            pipelineContext,
            searchResults,
            options.conversationHistory,
        )) {
            chunks.push(chunk);
        }

        const groundedness = assessGroundedness(chunks.join(''), searchResults);
        if (groundedness.suppress) {
            console.warn(
                `[Pipeline] Streamed response withheld from public post — ${groundedness.reasons.join('; ')}`,
            );
            yield SUPPRESSED_RESPONSE_TEXT;
            return;
        }

        yield* chunks;
    }

    /**
     * Clean up resources (Pathfinder session, etc.)
     */
    destroy(): void {
        this.pathfinder.disconnect();
    }
}

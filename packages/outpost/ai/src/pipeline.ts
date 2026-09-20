import type {
    PipelineContext,
    PipelineOptions,
    PipelineResult,
    TicketClassification,
    TokenUsage,
    SearchResult,
    GeneratedResponse,
} from './types.js';
import { ConfidenceLevel, SUPPRESSED_CONFIDENCE_CAP, classifyConfidence } from './types.js';
import { assessGroundedness } from './groundedness.js';
import { AI_CONFIDENCE } from '@copilotkit/outpost/shared';
import { PathfinderClient } from './pathfinder.js';
import {
    SupportAgent,
    InvalidSupportReplyError,
    InvestigationBudgetError,
    supportConversation,
} from './support-agent.js';
import { supportReplyText } from './support-reply.js';
import type { SupportReply } from './support-reply.js';
import { lintDraft, describeVerdict } from './eval/linter.js';
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

/** Public handoff copy makes no claim that every consumer has already escalated. */
export const SUPPRESSED_RESPONSE_TEXT =
    'This needs a maintainer review to give you a reliable next step.';

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
 * Orchestrates investigation → independent confidence verification → formatting.
 * Invalid drafts become handoffs; provider/transport failures propagate so workers retry.
 * An explicit Anthropic provider retains the legacy retrieval/generation path.
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
    private supportAgent?: Pick<SupportAgent, 'investigate'>;
    private pathfinder: PathfinderClient;
    private generator?: ResponseGenerator;
    private confidenceScorer: ConfidenceScorer;
    private classifier: TicketClassifier;
    private formatter: ResponseFormatter;

    constructor(options?: {
        supportAgent?: Pick<SupportAgent, 'investigate'>;
        pathfinder?: PathfinderClient;
        generator?: ResponseGenerator;
        confidenceScorer?: ConfidenceScorer;
        classifier?: TicketClassifier;
        formatter?: ResponseFormatter;
    }) {
        validateConfig();
        this.pathfinder = options?.pathfinder ?? new PathfinderClient();
        this.supportAgent =
            options?.supportAgent ??
            (config.responseProvider === 'openai'
                ? new SupportAgent({ pathfinder: this.pathfinder, model: config.responseModel })
                : undefined);
        this.generator = options?.generator;
        this.confidenceScorer = options?.confidenceScorer ?? new ConfidenceScorer();
        this.classifier = options?.classifier ?? new TicketClassifier();
        this.formatter = options?.formatter ?? new ResponseFormatter();
    }

    private legacyGenerator(): ResponseGenerator {
        return (this.generator ??= new ResponseGenerator());
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

        let reply: SupportReply | undefined;
        let searchResults: SearchResult[];
        let generatedResponse: GeneratedResponse;
        let mustRoute = false;
        const pipelineContext: PipelineContext = {
            question,
            source: options.source,
            questionMetadata: options.questionMetadata,
        };
        if (this.supportAgent) {
            try {
                const investigation = await this.supportAgent.investigate(
                    pipelineContext,
                    options.conversationHistory,
                );
                reply = investigation.reply;
                searchResults = investigation.sources;
                mustRoute = reply.decision === 'route';
                generatedResponse = {
                    text: supportReplyText(reply),
                    sources: searchResults,
                    confidenceScore: mustRoute ? SUPPRESSED_CONFIDENCE_CAP : 1,
                    confidenceLevel: mustRoute ? ConfidenceLevel.LOW : ConfidenceLevel.HIGH,
                    reasoning: reply.handoffReason,
                    tokenUsage: investigation.tokenUsage,
                };
            } catch (error) {
                if (
                    !(error instanceof InvalidSupportReplyError) &&
                    !(error instanceof InvestigationBudgetError)
                )
                    throw error;
                // Invalid drafts route to review. Transport failures propagate for worker retry.
                console.error(
                    '[Pipeline] Support investigation failed:',
                    error instanceof Error ? error.message : String(error),
                );
                mustRoute = true;
                searchResults = [];
                generatedResponse = {
                    text: '',
                    sources: [],
                    confidenceScore: 0,
                    confidenceLevel: ConfidenceLevel.LOW,
                    reasoning: 'Investigation failed validation or execution',
                };
            }
        } else {
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
            searchResults = interleaveByRank(code, docs).slice(0, config.pathfinder.defaultLimit);

            generatedResponse = await this.legacyGenerator().generate(
                pipelineContext,
                searchResults,
                options.conversationHistory,
            );
        }
        const lint = lintDraft(
            generatedResponse.text,
            searchResults,
            config.draftLintMode === 'enforce' ? 'enforce' : 'report',
        );
        if (lint.wouldCollapse) console.warn(describeVerdict(lint, options.source));
        mustRoute ||= !lint.publish;

        // Step 3: Score confidence against the ACTUAL generated response
        // (sequential, not parallel — the scorer needs the real text to
        // produce a meaningful signal, not a retrieval-quality proxy).
        const confidenceAssessment = mustRoute
            ? { score: 0, degraded: true, tokenUsage: { inputTokens: 0, outputTokens: 0 } }
            : await this.confidenceScorer
                  .score(
                      this.supportAgent
                          ? supportConversation(pipelineContext, options.conversationHistory)
                          : question,
                      generatedResponse.text,
                      searchResults,
                  )
                  .catch((error) => {
                      console.error(
                          `[Pipeline] Confidence scoring failed: ${error instanceof Error ? error.message : String(error)}`,
                      );
                      // The LLM scorer is unavailable — the heuristic fallback scores off
                      // Pathfinder's synthetic rank-scores (not real relevance), so it is an
                      // UNCERTAIN signal. Mark it degraded so it can't be trusted as HIGH below.
                      return {
                          ...this.confidenceScorer.heuristicScore(searchResults),
                          degraded: true,
                      };
                  });

        // The new provider publishes only when the independent verifier is usable.
        mustRoute ||=
            !!this.supportAgent &&
            (confidenceAssessment.degraded || confidenceAssessment.score < AI_CONFIDENCE.ESCALATE);

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
        const calibration = Number.isFinite(options.confidenceCalibration)
            ? Math.max(-0.15, Math.min(0.15, options.confidenceCalibration ?? 0))
            : 0;
        let finalConfidenceScore = Math.max(
            0,
            Math.min(
                1,
                (Number.isFinite(combinedConfidenceScore) ? combinedConfidenceScore : 0) +
                    calibration,
            ),
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
        if (mustRoute || groundedness.suppress || groundedness.forcesEscalation) {
            finalConfidenceScore = Math.min(finalConfidenceScore, SUPPRESSED_CONFIDENCE_CAP);
        }

        // Safety cap: a DEGRADED confidence signal (LLM scorer unavailable → heuristic
        // fallback over Pathfinder's synthetic rank-scores) must never present as HIGH.
        // HIGH suppresses the disclaimer and is treated as authoritative, so an ungrounded
        // answer scored high by the heuristic would post with no caveat. Cap to the highest
        // score that still classifies below HIGH so the response keeps a disclaimer. This
        // only ever LOWERS the score — a genuinely low degraded signal is left untouched and
        // still falls through to escalation.
        if (confidenceAssessment.degraded && finalConfidenceScore >= AI_CONFIDENCE.HIGH_THRESHOLD) {
            finalConfidenceScore = DEGRADED_CONFIDENCE_CAP;
        }
        const finalConfidence = classifyConfidence(finalConfidenceScore);

        // Step 4: Format for target platform.
        //
        // THE GATE. A suppressed draft never reaches `formatted`, so the withheld
        // text cannot leak through any consumer — publishing `formatted` is
        // always safe by construction. `response` below still carries the draft
        // for the human handling the escalation.
        const suppressed = mustRoute || groundedness.suppress;
        const publishedText = suppressed ? SUPPRESSED_RESPONSE_TEXT : generatedResponse.text;

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
        const disclaimerText = suppressed
            ? AI_DISCLAIMER
            : willEscalate
              ? AI_DISCLAIMER_ESCALATED
              : AI_DISCLAIMER_REVIEWED;

        const formatOptions = { addDisclaimer: needsDisclaimer, disclaimerText };
        const formatted =
            reply && !suppressed
                ? this.formatter.formatStructured(reply, options.source, formatOptions)
                : this.formatter.format(publishedText, options.source, formatOptions);

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
            suppressed,
            handoffReason: suppressed
                ? (
                      generatedResponse.reasoning ||
                      [...groundedness.reasons, ...(!lint.publish ? lint.reasons : [])].join(
                          '; ',
                      ) ||
                      (confidenceAssessment.degraded
                          ? 'Independent verification was unavailable or malformed'
                          : 'Independent verification found insufficient support')
                  ).slice(0, 2000)
                : undefined,
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
     * and only then yields. Legacy model streams preserve their chunk boundaries;
     * structured support replies yield the complete formatted output, including
     * platform continuations and separate web details. In both cases,
     * time-to-first-token equals total latency.
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
        if (this.supportAgent) {
            const { formatted } = await this.generateSupportResponse(question, options);
            // Split formats store the first part in text too; publish the parts once.
            const text = formatted.parts?.length ? formatted.parts.join('\n\n') : formatted.text;
            yield [text, options.source === 'web' ? formatted.details : undefined]
                .filter(Boolean)
                .join('\n\n');
            return;
        }

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
        for await (const chunk of this.legacyGenerator().generateStream(
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

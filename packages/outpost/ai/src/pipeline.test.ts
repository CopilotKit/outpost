import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
    config: {
        anthropicApiKey: 'test-key',
        pathfinderMcpUrl: 'http://localhost:8787',
        responseModel: 'claude-sonnet-4-6',
        confidenceModel: 'claude-haiku-4-5-20251001',
        classifierModel: 'claude-haiku-4-5-20251001',
        sentimentModel: 'claude-haiku-4-5-20251001',
        maxResponseTokens: 2048,
        responseTemperature: 0.3,
        confidence: { highThreshold: 0.8, mediumThreshold: 0.5 },
    },
    validateConfig: vi.fn(),
}));

import { AI_CONFIDENCE } from '@copilotkit/outpost/shared';
import { AIPipeline, SUPPRESSED_RESPONSE_TEXT } from './pipeline.js';
import { AI_DISCLAIMER, AI_DISCLAIMER_ESCALATED, AI_DISCLAIMER_REVIEWED } from './formatter.js';
import { ConfidenceLevel, TicketPriority, TicketType } from './types.js';
import type { SearchResult, GeneratedResponse } from './types.js';
import type { ConfidenceAssessment } from './confidence.js';

// Create mock instances
const mockSearchDocs = vi.fn();
const mockDisconnect = vi.fn();
const mockGenerate = vi.fn();
const mockGenerateStream = vi.fn();
const mockScore = vi.fn();
const mockHeuristicScore = vi.fn();
const mockClassify = vi.fn();
const mockHeuristicClassify = vi.fn();
const mockFormat = vi.fn();
const mockBuildQuery = vi.fn();

function createPipeline() {
    return new AIPipeline({
        queryBuilder: {
            build: mockBuildQuery,
        } as never,
        pathfinder: {
            searchDocs: mockSearchDocs,
            exploreDocs: vi.fn(),
            queryKnowledgeBase: vi.fn(),
            disconnect: mockDisconnect,
        } as never,
        generator: {
            generate: mockGenerate,
            generateStream: mockGenerateStream,
        } as never,
        confidenceScorer: {
            score: mockScore,
            heuristicScore: mockHeuristicScore,
        } as never,
        classifier: {
            classify: mockClassify,
            heuristicClassify: mockHeuristicClassify,
        } as never,
        formatter: {
            format: mockFormat,
        } as never,
    });
}

const sampleSearchResults: SearchResult[] = [
    {
        title: 'Actions',
        content: 'Guide to actions...',
        score: 0.9,
        sourceUrl: 'https://docs.copilotkit.ai/actions',
    },
    { title: 'Hooks', content: 'Guide to hooks...', score: 0.85 },
];

const sampleGeneratedResponse: GeneratedResponse = {
    text: 'Here is how to use CopilotKit actions...',
    confidenceScore: 0.85,
    confidenceLevel: ConfidenceLevel.HIGH,
    sources: sampleSearchResults,
    reasoning: 'Based on 2 sources',
    tokenUsage: { inputTokens: 500, outputTokens: 100 },
    latencyMs: 2000,
};

const sampleConfidence: ConfidenceAssessment = {
    level: ConfidenceLevel.HIGH,
    score: 0.88,
    reasoning: 'Good match',
    tokenUsage: { inputTokens: 200, outputTokens: 30 },
    degraded: false,
};

describe('AIPipeline', () => {
    let pipeline: AIPipeline;

    beforeEach(() => {
        vi.resetAllMocks();
        pipeline = createPipeline();

        // Set up defaults. The query builder passes the question through
        // untouched unless a test overrides it.
        mockBuildQuery.mockImplementation(async (question: string) => ({
            query: question,
            sanitized: question,
            degraded: false,
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
        }));
        mockSearchDocs.mockResolvedValue(sampleSearchResults);
        mockGenerate.mockResolvedValue(sampleGeneratedResponse);
        mockScore.mockResolvedValue(sampleConfidence);
        mockFormat.mockReturnValue({
            text: 'Formatted response',
            truncated: false,
        });
    });

    describe('generateSupportResponse', () => {
        it('should run the full pipeline end-to-end', async () => {
            const result = await pipeline.generateSupportResponse(
                'How do I use CopilotKit actions?',
                { source: 'discord' },
            );

            expect(result.response).toBe('Here is how to use CopilotKit actions...');
            expect(result.formatted.text).toBe('Formatted response');
            expect(result.searchResults).toEqual(sampleSearchResults);
            expect(result.tokenUsage.inputTokens).toBe(700); // 500 + 200
            expect(result.tokenUsage.outputTokens).toBe(130); // 100 + 30
            expect(result.latencyMs).toBeGreaterThanOrEqual(0);
        });

        // Regression: the raw inbound body used to be forwarded verbatim as the
        // docs-search query, so Discord mentions, custom emoji, pasted channel
        // sidebars, and issue-template boilerplate all reached the embedder.
        it('searches with the distilled query, not the raw body', async () => {
            const rawBody = '<@!123> hey <#456> — how do I render generative UI?';
            mockBuildQuery.mockResolvedValue({
                query: 'render generative UI',
                sanitized: 'hey — how do I render generative UI?',
                degraded: false,
                tokenUsage: { inputTokens: 40, outputTokens: 8 },
            });

            await pipeline.generateSupportResponse(rawBody, { source: 'discord' });

            expect(mockBuildQuery).toHaveBeenCalledWith(rawBody);
            expect(mockSearchDocs).toHaveBeenCalledWith({ query: 'render generative UI' });
        });

        it('generates from the sanitized body, not the distilled query', async () => {
            mockBuildQuery.mockResolvedValue({
                query: 'render generative UI',
                sanitized: 'hey — how do I render generative UI?',
                degraded: false,
                tokenUsage: { inputTokens: 40, outputTokens: 8 },
            });

            await pipeline.generateSupportResponse('<@!123> hey — how do I render generative UI?', {
                source: 'discord',
            });

            expect(mockGenerate).toHaveBeenCalledWith(
                expect.objectContaining({ question: 'hey — how do I render generative UI?' }),
                expect.any(Array),
                undefined,
            );
            expect(mockScore).toHaveBeenCalledWith(
                'hey — how do I render generative UI?',
                expect.any(String),
                expect.any(Array),
            );
        });

        it('counts the distiller tokens in the aggregate usage', async () => {
            mockBuildQuery.mockResolvedValue({
                query: 'render generative UI',
                sanitized: 'how do I render generative UI?',
                degraded: false,
                tokenUsage: { inputTokens: 40, outputTokens: 8 },
            });

            const result = await pipeline.generateSupportResponse('question', {
                source: 'discord',
            });

            expect(result.tokenUsage.inputTokens).toBe(740); // 40 + 500 + 200
            expect(result.tokenUsage.outputTokens).toBe(138); // 8 + 100 + 30
        });

        it('should pass the source channel into the generator context', async () => {
            await pipeline.generateSupportResponse('test question', { source: 'discord' });

            expect(mockGenerate).toHaveBeenCalledWith(
                expect.objectContaining({ source: 'discord' }),
                expect.any(Array),
                undefined,
            );
        });

        it('should use the more conservative confidence score', async () => {
            // Generator says 0.85, scorer says 0.6 — should use 0.6
            mockScore.mockResolvedValue({
                ...sampleConfidence,
                score: 0.6,
                level: ConfidenceLevel.MEDIUM,
            });

            const result = await pipeline.generateSupportResponse('test question', {
                source: 'discord',
            });

            expect(result.confidenceScore).toBe(0.6);
            expect(result.confidenceLevel).toBe(ConfidenceLevel.MEDIUM);
        });

        it('should add disclaimer for non-HIGH confidence', async () => {
            mockScore.mockResolvedValue({
                ...sampleConfidence,
                score: 0.6,
                level: ConfidenceLevel.MEDIUM,
            });

            await pipeline.generateSupportResponse('test question', { source: 'github' });

            expect(mockFormat).toHaveBeenCalledWith(
                expect.any(String),
                'github',
                expect.objectContaining({
                    addDisclaimer: true,
                }),
            );
        });

        it('should not add disclaimer for HIGH confidence', async () => {
            await pipeline.generateSupportResponse('test question', { source: 'discord' });

            expect(mockFormat).toHaveBeenCalledWith(
                expect.any(String),
                'discord',
                expect.objectContaining({
                    addDisclaimer: false,
                }),
            );
        });

        // Regression for #115: the "we've escalated this" copy must appear iff
        // the worker would actually enqueue an ESCALATION job (score < ESCALATE
        // = 0.4), not merely because the level is LOW (score < 0.5).
        //
        // Returns the WHOLE format options object, not just the copy: `disclaimerText`
        // is passed to the formatter unconditionally but only rendered when
        // `addDisclaimer` is true, so asserting on the text without also reading the
        // flag can assert on copy that never reaches a thread.
        const disclaimerOptsFor = async (
            score: number,
        ): Promise<{ addDisclaimer: boolean; disclaimerText: string }> => {
            mockScore.mockResolvedValue({ ...sampleConfidence, score });
            await pipeline.generateSupportResponse('q', { source: 'discord' });
            return mockFormat.mock.calls.at(-1)?.[2] as {
                addDisclaimer: boolean;
                disclaimerText: string;
            };
        };

        it('promises escalation only when the score is below the ESCALATE gate (0.4)', async () => {
            const opts = await disclaimerOptsFor(0.3);
            expect(opts.addDisclaimer).toBe(true);
            expect(opts.disclaimerText).toBe(AI_DISCLAIMER_ESCALATED);
        });

        // There is no third "MEDIUM" variant: the LOW-but-not-escalated band and the
        // MEDIUM band deliberately share AI_DISCLAIMER_REVIEWED, because the thing
        // that distinguishes them (retrieval score) is not something the reporter can
        // act on — what matters is only whether a human follow-up was promised. Pinned
        // by constant so a future third variant has to be an explicit decision.
        it('uses the same reviewed copy for the LOW-but-not-escalated band [0.4, 0.5) and MEDIUM', async () => {
            const low = await disclaimerOptsFor(0.45);
            const medium = await disclaimerOptsFor(0.6);

            // Was the bug: 0.45 is LOW but never escalated, so no false promise.
            expect(low.addDisclaimer).toBe(true);
            expect(low.disclaimerText).toBe(AI_DISCLAIMER_REVIEWED);
            expect(medium.addDisclaimer).toBe(true);
            expect(medium.disclaimerText).toBe(AI_DISCLAIMER_REVIEWED);
            expect(low.disclaimerText).not.toContain('escalated');
        });

        // No externally-visible disclaimer may hedge about the response's own
        // completeness — that copy invites the reader to distrust an answer we
        // chose to post. Confidence is expressed by escalating, not by hedging.
        //
        // Only non-HIGH scores are listed: at HIGH nothing is rendered, so a row for
        // it would be asserting on copy the reader never sees. The HIGH case is
        // covered by its own "renders no disclaimer at all" test below.
        it.each([0.1, 0.3, 0.45, 0.6])(
            'never hedges about completeness at score %s',
            async (score) => {
                const opts = await disclaimerOptsFor(score);
                expect(opts.addDisclaimer).toBe(true);
                expect(opts.disclaimerText).not.toMatch(
                    /may be incomplete|might be incomplete|may not be accurate/i,
                );
                expect(opts.disclaimerText).toContain(AI_DISCLAIMER);
            },
        );

        // Belt and braces on the copy itself, independent of any score: every
        // variant that can be rendered is checked, so adding a fourth constant
        // cannot introduce hedging copy unnoticed.
        it.each([
            ['AI_DISCLAIMER', AI_DISCLAIMER],
            ['AI_DISCLAIMER_ESCALATED', AI_DISCLAIMER_ESCALATED],
            ['AI_DISCLAIMER_REVIEWED', AI_DISCLAIMER_REVIEWED],
        ])('%s never hedges about completeness', (_name, text) => {
            expect(text).not.toMatch(/may be incomplete|might be incomplete|may not be accurate/i);
            expect(text).toContain(AI_DISCLAIMER);
        });

        // At HIGH the formatter is told not to render one, so there is no copy to
        // assert on — that absence is the assertion.
        it('renders no disclaimer at all for a HIGH score', async () => {
            const opts = await disclaimerOptsFor(0.95);
            // min(generator 0.85, scorer 0.95) = 0.85 → HIGH.
            expect(opts.addDisclaimer).toBe(false);
        });

        // The scores above measure retrieval quality; these measure whether the
        // answer stayed inside what was retrieved. Without this, a fabrication
        // inherits the score of a good docs match (how #6167 got posted).
        describe('groundedness', () => {
            // `generatedResponse.groundedness ?? assessGroundedness(...)` has two
            // branches and the shared fixture omits `groundedness`, so every OTHER
            // test in this file drives the recompute fallback. The pass-through is
            // the whole point of the single-deduction fix — the generator assesses
            // once, the pipeline applies once — so it is pinned here with a sentinel
            // assessment the recompute could not possibly produce for this text.
            describe('uses the generator-supplied assessment when there is one', () => {
                /**
                 * Deliberately impossible from `assessGroundedness('Here is how to
                 * use CopilotKit actions...', sampleSearchResults)`, which yields a
                 * zero penalty and no suppression. If the pipeline recomputes, none
                 * of these values survive.
                 */
                const SENTINEL_ASSESSMENT = {
                    penalty: 0.25,
                    // Deliberately claim-free: a charged claim is clamped below the
                    // escalation gate, which would mask the penalty arithmetic this
                    // test exists to observe. The identifier, hedge count and reason
                    // are still impossible for a recompute of this text, so the
                    // sentinel keeps its distinguishing power.
                    unverifiedClaims: [],
                    unsourcedIdentifiers: ['copilotKitSentinel'],
                    hedgeCount: 7,
                    suppress: false,
                    reasons: ['sentinel reason'],
                };

                it('passes the generator assessment through untouched', async () => {
                    mockGenerate.mockResolvedValue({
                        ...sampleGeneratedResponse,
                        groundedness: SENTINEL_ASSESSMENT,
                    });

                    const result = await pipeline.generateSupportResponse('q', {
                        source: 'github',
                    });

                    expect(result.groundedness).toEqual(SENTINEL_ASSESSMENT);
                    // And it is the value actually APPLIED: 0.85 − 0.25 = 0.60. A
                    // recompute would leave the score at 0.85.
                    expect(result.confidenceScore).toBeCloseTo(0.6, 5);
                });

                // The supplied assessment also drives the escalation clamp, not just
                // the arithmetic — an own-verification claim the generator charged
                // must reach a human even though the pipeline never re-derived it.
                it('clamps below the escalation gate on a supplied own-verification claim', async () => {
                    mockGenerate.mockResolvedValue({
                        ...sampleGeneratedResponse,
                        groundedness: {
                            ...SENTINEL_ASSESSMENT,
                            unverifiedClaims: ['claims to have reproduced or tested'],
                            forcesEscalation: true,
                        },
                    });

                    const result = await pipeline.generateSupportResponse('q', {
                        source: 'github',
                    });

                    expect(result.confidenceScore).toBeLessThan(AI_CONFIDENCE.ESCALATE);
                });

                // The other half of that contract, and the reason the pipeline reads
                // `forcesEscalation` rather than `unverifiedClaims.length`: a charged
                // claim that is only reporting what the docs say gets priced and
                // published, without paging anyone.
                it('does not clamp on a charged claim that is not own-verification', async () => {
                    mockGenerate.mockResolvedValue({
                        ...sampleGeneratedResponse,
                        groundedness: {
                            ...SENTINEL_ASSESSMENT,
                            unverifiedClaims: ['claims a known bug'],
                            forcesEscalation: false,
                        },
                    });

                    const result = await pipeline.generateSupportResponse('q', {
                        source: 'github',
                    });

                    // 0.85 − 0.25 penalty = 0.60, well clear of the gate.
                    expect(result.confidenceScore).toBeCloseTo(0.6, 5);
                    expect(result.confidenceScore).toBeGreaterThan(AI_CONFIDENCE.ESCALATE);
                });

                it('honours a generator-supplied suppress flag the recompute would not set', async () => {
                    mockGenerate.mockResolvedValue({
                        ...sampleGeneratedResponse,
                        groundedness: { ...SENTINEL_ASSESSMENT, suppress: true },
                    });

                    const result = await pipeline.generateSupportResponse('q', {
                        source: 'github',
                    });

                    // The text is perfectly grounded, so only the injected flag can
                    // produce this — proof the pipeline read the generator's verdict.
                    expect(result.suppressed).toBe(true);
                    expect(mockFormat).toHaveBeenCalledWith(
                        SUPPRESSED_RESPONSE_TEXT,
                        'github',
                        expect.any(Object),
                    );
                });

                it('recomputes when the generator supplies no assessment', async () => {
                    // The fallback branch, asserted explicitly rather than relied on
                    // implicitly: this fixture has no `groundedness` key.
                    mockGenerate.mockResolvedValue({
                        ...sampleGeneratedResponse,
                        text: 'Override `.copilotKitInputControls` to fix it.',
                    });

                    const result = await pipeline.generateSupportResponse('q', {
                        source: 'github',
                    });

                    expect(result.groundedness.unsourcedIdentifiers).toEqual([
                        'copilotKitInputControls',
                    ]);
                    expect(result.groundedness.penalty).toBeCloseTo(0.15, 5);
                });
            });

            it('leaves a grounded response unpenalized and publishable', async () => {
                const result = await pipeline.generateSupportResponse('q', { source: 'github' });

                expect(result.groundedness.penalty).toBe(0);
                expect(result.suppressed).toBe(false);
                expect(result.confidenceScore).toBe(0.85);
            });

            it('deducts the penalty from the final score', async () => {
                mockGenerate.mockResolvedValue({
                    ...sampleGeneratedResponse,
                    text: 'Override `.copilotKitInputControls` to fix it.',
                });

                const result = await pipeline.generateSupportResponse('q', { source: 'github' });

                // 0.85 (min of generator/scorer) − 0.15 for one invented identifier
                expect(result.confidenceScore).toBeCloseTo(0.7, 5);
                expect(result.groundedness.unsourcedIdentifiers).toEqual([
                    'copilotKitInputControls',
                ]);
            });

            // The boundary: the draft must never reach the formatter (and so never
            // reach `formatted`) when it is suppressed. Every consumer publishes
            // `formatted`, so the swap here is what makes all of them safe.
            it('hands the formatter the replacement copy, not the draft', async () => {
                const draft = 'Override `.copilotKitGhostA` and `.copilotKitGhostB` to fix it.';
                mockGenerate.mockResolvedValue({ ...sampleGeneratedResponse, text: draft });

                const result = await pipeline.generateSupportResponse('q', { source: 'github' });

                expect(result.suppressed).toBe(true);
                expect(mockFormat).toHaveBeenCalledWith(
                    SUPPRESSED_RESPONSE_TEXT,
                    'github',
                    expect.any(Object),
                );
                // ...while the draft stays on the result for the human escalation.
                expect(result.response).toBe(draft);
            });

            // SUPPRESSED_RESPONSE_TEXT already promises a human follow-up, so the
            // escalated variant would say it twice.
            it('pairs the replacement with the plain disclaimer, not the escalated one', async () => {
                mockGenerate.mockResolvedValue({
                    ...sampleGeneratedResponse,
                    text: 'Override `.copilotKitGhostA` and `.copilotKitGhostB` to fix it.',
                });

                await pipeline.generateSupportResponse('q', { source: 'github' });

                expect(mockFormat).toHaveBeenCalledWith(
                    SUPPRESSED_RESPONSE_TEXT,
                    'github',
                    expect.objectContaining({
                        addDisclaimer: true,
                        disclaimerText: AI_DISCLAIMER,
                    }),
                );
            });

            it('leaves the draft as the published text when it is grounded', async () => {
                await pipeline.generateSupportResponse('q', { source: 'github' });

                expect(mockFormat).toHaveBeenCalledWith(
                    sampleGeneratedResponse.text,
                    'github',
                    expect.any(Object),
                );
            });

            // Withholding is driven by the objective signal only — identifiers no
            // retrieved source contains. Claim wording is fallible English, so it
            // buys a penalty and an escalation, never a withheld reply.
            it('penalizes a bug-confirming response into escalation without withholding it', async () => {
                mockGenerate.mockResolvedValue({
                    ...sampleGeneratedResponse,
                    text: '## Bug Confirmed: Cursor Jump\n\nRoot cause is a re-render.',
                });

                const result = await pipeline.generateSupportResponse('q', { source: 'github' });

                expect(result.groundedness.unverifiedClaims.length).toBeGreaterThan(0);
                expect(result.suppressed).toBe(false);
                expect(result.groundedness.suppress).toBe(false);
                // The reporter still gets a human: the penalty clears the gate on its own.
                expect(result.confidenceScore).toBeLessThan(AI_CONFIDENCE.ESCALATE);
            });

            it('marks a response naming identifiers absent from the sources as suppressed', async () => {
                mockGenerate.mockResolvedValue({
                    ...sampleGeneratedResponse,
                    text: 'Override `.copilotKitGhostA` and `.copilotKitGhostB` to fix it.',
                });

                const result = await pipeline.generateSupportResponse('q', { source: 'github' });

                expect(result.groundedness.unsourcedIdentifiers).toEqual([
                    'copilotKitGhostA',
                    'copilotKitGhostB',
                ]);
                expect(result.suppressed).toBe(true);
                expect(result.groundedness.suppress).toBe(true);
                expect(result.confidenceScore).toBeLessThan(AI_CONFIDENCE.ESCALATE);
            });

            // Positive feedback tunes how we weigh well-formed answers. It must not
            // buy back a fabrication, so the penalty lands after calibration.
            it('cannot be offset by positive feedback calibration', async () => {
                mockGenerate.mockResolvedValue({
                    ...sampleGeneratedResponse,
                    text: 'Bug Confirmed. Root cause is a re-render. The fix is trivial.',
                });

                const withBoost = await pipeline.generateSupportResponse('q', {
                    source: 'github',
                    confidenceCalibration: 0.15,
                });

                // 0.85 + 0.15 calibration = 1.0, minus the capped 0.6 penalty = 0.4 —
                // which is exactly the gate, and the gate tests `<`. Arithmetic alone
                // would leave this worst case unescalated, so a charged claim is
                // clamped below the gate outright.
                expect(withBoost.groundedness.penalty).toBeCloseTo(0.6, 5);
                expect(withBoost.confidenceScore).toBeLessThan(AI_CONFIDENCE.ESCALATE);
                expect(withBoost.confidenceLevel).toBe(ConfidenceLevel.LOW);
            });

            // The knife-edge above is not a rounding curiosity: it is the ONLY case
            // where a bot that asserted an unverifiable claim would page nobody.
            it('escalates a charged claim even at a perfect score with maximum boost', async () => {
                mockScore.mockResolvedValue({ ...sampleConfidence, score: 1 });
                mockGenerate.mockResolvedValue({
                    ...sampleGeneratedResponse,
                    confidenceScore: 1,
                    text: 'Bug Confirmed. Root cause is a re-render. The fix is trivial.',
                });

                const result = await pipeline.generateSupportResponse('q', {
                    source: 'github',
                    confidenceCalibration: 0.2,
                });

                expect(result.groundedness.unverifiedClaims.length).toBeGreaterThan(0);
                // Not withheld — claim wording never gates publication...
                expect(result.suppressed).toBe(false);
                // ...but it does guarantee a human sees it.
                expect(result.confidenceScore).toBeLessThan(AI_CONFIDENCE.ESCALATE);
            });

            // A boost cannot lift a withheld answer over the escalation gate either:
            // the suppression clamp sits below it by construction.
            it('keeps a suppressed response below the gate even with a positive boost', async () => {
                mockGenerate.mockResolvedValue({
                    ...sampleGeneratedResponse,
                    text: 'Override `.copilotKitGhostA` and `.copilotKitGhostB` to fix it.',
                });

                const withBoost = await pipeline.generateSupportResponse('q', {
                    source: 'github',
                    confidenceCalibration: 0.15,
                });

                expect(withBoost.suppressed).toBe(true);
                expect(withBoost.confidenceScore).toBeLessThan(AI_CONFIDENCE.ESCALATE);
            });
        });

        it('should handle Pathfinder failure gracefully', async () => {
            mockSearchDocs.mockRejectedValueOnce(new Error('MCP down'));

            const result = await pipeline.generateSupportResponse('test question', {
                source: 'web',
            });

            // Should still return a result, just with empty search results
            expect(result.response).toBeDefined();
            expect(mockGenerate).toHaveBeenCalledWith(
                expect.any(Object),
                [], // Empty results after failure
                undefined,
            );
        });

        it('should handle generator failure by rejecting (generator errors are not caught)', async () => {
            mockGenerate.mockRejectedValueOnce(new Error('Claude down'));

            // Generator is awaited directly; its rejection propagates.
            // The pipeline does NOT silently swallow generator failures.
            await expect(
                pipeline.generateSupportResponse('test question', { source: 'discord' }),
            ).rejects.toThrow('Claude down');
        });

        it('should handle confidence scoring failure gracefully', async () => {
            mockScore.mockRejectedValueOnce(new Error('Scorer error'));
            mockHeuristicScore.mockReturnValue({
                level: ConfidenceLevel.MEDIUM,
                score: 0.6,
                reasoning: 'Heuristic fallback',
                tokenUsage: { inputTokens: 0, outputTokens: 0 },
            });

            const result = await pipeline.generateSupportResponse('test question', {
                source: 'discord',
            });

            // Should use heuristic fallback
            expect(result.response).toBeDefined();
        });

        it('should score confidence against the actual generated response text, not a placeholder', async () => {
            await pipeline.generateSupportResponse('a question', { source: 'discord' });

            expect(mockScore).toHaveBeenCalledWith(
                'a question',
                sampleGeneratedResponse.text,
                sampleSearchResults,
            );
        });

        it('should pass conversation history to generator', async () => {
            const history = [
                { role: 'user' as const, content: 'What is CopilotKit?' },
                { role: 'assistant' as const, content: 'CopilotKit is...' },
            ];

            await pipeline.generateSupportResponse('How about streaming?', {
                source: 'discord',
                conversationHistory: history,
            });

            expect(mockGenerate).toHaveBeenCalledWith(
                expect.any(Object),
                expect.any(Array),
                history,
            );
        });
    });

    describe('degraded confidence safety cap', () => {
        it('caps a degraded HIGH score below HIGH so a disclaimer still shows (scorer threw)', async () => {
            // LLM scorer unavailable → pipeline catch → heuristic fallback, which scores
            // off Pathfinder's synthetic rank-scores and can look confidently HIGH.
            mockScore.mockRejectedValueOnce(new Error('scorer down'));
            mockHeuristicScore.mockReturnValue({
                level: ConfidenceLevel.HIGH,
                score: 0.93,
                reasoning: 'heuristic over synthetic scores',
                tokenUsage: { inputTokens: 0, outputTokens: 0 },
                degraded: false,
            });

            const result = await pipeline.generateSupportResponse('q', { source: 'discord' });

            // Must NOT present as HIGH → disclaimer is kept.
            expect(result.confidenceLevel).not.toBe(ConfidenceLevel.HIGH);
            expect(result.confidenceScore).toBeLessThan(0.8);
            expect(mockFormat).toHaveBeenCalledWith(
                expect.any(String),
                'discord',
                expect.objectContaining({ addDisclaimer: true }),
            );
        });

        it('caps when the scorer itself reports degraded=true with a HIGH score', async () => {
            mockScore.mockResolvedValue({
                level: ConfidenceLevel.HIGH,
                score: 0.95,
                reasoning: 'internal degraded (parse/fallback)',
                tokenUsage: { inputTokens: 0, outputTokens: 0 },
                degraded: true,
            });

            const result = await pipeline.generateSupportResponse('q', { source: 'discord' });

            expect(result.confidenceLevel).not.toBe(ConfidenceLevel.HIGH);
            expect(result.confidenceScore).toBeLessThan(0.8);
        });

        it('leaves a degraded + genuinely-low score untouched (still escalates)', async () => {
            // Scorer returns a low, degraded signal. The cap only lowers HIGH scores —
            // it must NOT touch a low one, so the < ESCALATE (0.4) escalation still fires.
            mockScore.mockResolvedValue({
                level: ConfidenceLevel.LOW,
                score: 0.2,
                reasoning: 'degraded + low',
                tokenUsage: { inputTokens: 0, outputTokens: 0 },
                degraded: true,
            });

            const result = await pipeline.generateSupportResponse('q', { source: 'discord' });

            expect(result.confidenceScore).toBeCloseTo(0.2, 5);
            expect(result.confidenceLevel).toBe(ConfidenceLevel.LOW);
            expect(result.confidenceScore).toBeLessThan(0.4); // preserved → worker escalates
        });

        it('does NOT cap a healthy (non-degraded) HIGH score', async () => {
            mockScore.mockResolvedValue({
                level: ConfidenceLevel.HIGH,
                score: 0.9,
                reasoning: 'healthy',
                tokenUsage: { inputTokens: 0, outputTokens: 0 },
                degraded: false,
            });

            const result = await pipeline.generateSupportResponse('q', { source: 'discord' });

            expect(result.confidenceLevel).toBe(ConfidenceLevel.HIGH);
            expect(result.confidenceScore).toBeGreaterThanOrEqual(0.8);
            expect(mockFormat).toHaveBeenCalledWith(
                expect.any(String),
                'discord',
                expect.objectContaining({ addDisclaimer: false }),
            );
        });
    });

    // The streaming entry point cannot gate incrementally — you cannot know a draft
    // invents an identifier until you have read it to the end, and text already on
    // the wire cannot be recalled. So it buffers, assesses, then yields. These pin
    // that contract; without it this method is the one ungated path to a thread.
    describe('generateStreamingResponse', () => {
        async function* streamOf(...chunks: string[]): AsyncIterable<string> {
            for (const chunk of chunks) yield chunk;
        }

        async function collect(stream: AsyncIterable<string>): Promise<string[]> {
            const out: string[] = [];
            for await (const chunk of stream) out.push(chunk);
            return out;
        }

        it('yields the model chunks unchanged when the draft is grounded', async () => {
            mockGenerateStream.mockReturnValue(
                streamOf('Use the ', '`useCopilotAction` ', 'hook.'),
            );

            const chunks = await collect(
                pipeline.generateStreamingResponse('q', { source: 'web' }),
            );

            expect(chunks).toEqual(['Use the ', '`useCopilotAction` ', 'hook.']);
        });

        it('yields ONLY the replacement copy when the buffered draft is suppressed', async () => {
            mockGenerateStream.mockReturnValue(
                streamOf(
                    'Override `.copilotKitInputControls` ',
                    'and `.copilotKitInputControlsExpanded`.',
                ),
            );

            const chunks = await collect(
                pipeline.generateStreamingResponse('q', { source: 'web' }),
            );

            expect(chunks).toEqual([SUPPRESSED_RESPONSE_TEXT]);
            expect(chunks.join('')).not.toContain('copilotKitInputControls');
        });

        it('assesses the WHOLE draft, not a single chunk (chunk-local text looks fine)', async () => {
            // Split so no individual chunk carries both invented identifiers — a
            // per-chunk gate would pass this through.
            mockGenerateStream.mockReturnValue(
                streamOf(
                    'Override `.copilotKitInputControls`',
                    ' and also',
                    ' `.copilotKitInputControlsExpanded`.',
                ),
            );

            const chunks = await collect(
                pipeline.generateStreamingResponse('q', { source: 'web' }),
            );

            expect(chunks).toEqual([SUPPRESSED_RESPONSE_TEXT]);
        });

        it('passes the retrieved sources and history through to the generator', async () => {
            mockGenerateStream.mockReturnValue(streamOf('ok'));
            const history = [{ role: 'user' as const, content: 'hi' }];

            await collect(
                pipeline.generateStreamingResponse('q', {
                    source: 'web',
                    conversationHistory: history,
                }),
            );

            expect(mockGenerateStream).toHaveBeenCalledWith(
                expect.objectContaining({ question: 'q', source: 'web' }),
                sampleSearchResults,
                history,
            );
        });

        it('still yields when Pathfinder is down (empty sources)', async () => {
            mockSearchDocs.mockRejectedValueOnce(new Error('MCP down'));
            mockGenerateStream.mockReturnValue(streamOf('best effort'));

            const chunks = await collect(
                pipeline.generateStreamingResponse('q', { source: 'web' }),
            );

            expect(chunks).toEqual(['best effort']);
            expect(mockGenerateStream).toHaveBeenCalledWith(expect.any(Object), [], undefined);
        });
    });

    describe('classifyTicket', () => {
        it('should classify a ticket', async () => {
            mockClassify.mockResolvedValue({
                priority: TicketPriority.HIGH,
                type: TicketType.BUG,
                tags: ['copilotkit-runtime'],
                reasoning: 'Error report',
                tokenUsage: { inputTokens: 80, outputTokens: 30 },
            });

            const result = await pipeline.classifyTicket(
                'Error: CopilotRuntime crashes on startup',
            );

            expect(result.priority).toBe(TicketPriority.HIGH);
            expect(result.type).toBe(TicketType.BUG);
        });

        it('should fall back to heuristic on failure', async () => {
            mockClassify.mockRejectedValueOnce(new Error('API error'));
            mockHeuristicClassify.mockReturnValue({
                priority: TicketPriority.HIGH,
                type: TicketType.BUG,
                tags: [],
                reasoning: 'Heuristic',
            });

            const result = await pipeline.classifyTicket('Error: something broke');

            expect(result.priority).toBe(TicketPriority.HIGH);
            expect(result.tokenUsage.inputTokens).toBe(0);
        });
    });

    describe('destroy', () => {
        it('should disconnect Pathfinder', () => {
            pipeline.destroy();
            expect(mockDisconnect).toHaveBeenCalled();
        });
    });
});

describe('AIPipeline confidence calibration', () => {
    let pipeline: AIPipeline;

    beforeEach(() => {
        vi.resetAllMocks();
        pipeline = createPipeline();
        mockBuildQuery.mockImplementation(async (question: string) => ({
            query: question,
            sanitized: question,
            degraded: false,
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
        }));
        mockSearchDocs.mockResolvedValue(sampleSearchResults);
        mockGenerate.mockResolvedValue(sampleGeneratedResponse); // generator score 0.85
        mockScore.mockResolvedValue({
            ...sampleConfidence,
            score: 0.6,
            level: ConfidenceLevel.MEDIUM,
        });
        mockFormat.mockReturnValue({ text: 'Formatted response', truncated: false });
    });

    it('leaves the score unchanged when calibration is omitted (regression guard)', async () => {
        const result = await pipeline.generateSupportResponse('q', { source: 'discord' });
        // min(0.85, 0.6) = 0.6, no calibration
        expect(result.confidenceScore).toBeCloseTo(0.6, 5);
    });

    it('adds a positive calibration factor to the combined score', async () => {
        const result = await pipeline.generateSupportResponse('q', {
            source: 'discord',
            confidenceCalibration: 0.15,
        });
        expect(result.confidenceScore).toBeCloseTo(0.75, 5);
    });

    it('clamps the calibrated score to at most 1', async () => {
        mockScore.mockResolvedValue({
            ...sampleConfidence,
            score: 0.95,
            level: ConfidenceLevel.HIGH,
        });
        const result = await pipeline.generateSupportResponse('q', {
            source: 'discord',
            confidenceCalibration: 0.2, // min(0.85, 0.95)=0.85 + 0.2 = 1.05 → clamp
        });
        expect(result.confidenceScore).toBe(1);
    });

    it('clamps the calibrated score to at least 0', async () => {
        mockScore.mockResolvedValue({
            ...sampleConfidence,
            score: 0.05,
            level: ConfidenceLevel.LOW,
        });
        const result = await pipeline.generateSupportResponse('q', {
            source: 'discord',
            confidenceCalibration: -0.2, // min(0.85, 0.05)=0.05 - 0.2 = -0.15 → clamp
        });
        expect(result.confidenceScore).toBe(0);
    });
});

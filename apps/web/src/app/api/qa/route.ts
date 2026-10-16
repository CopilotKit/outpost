import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { AIPipeline } from '@copilotkit/outpost/ai';
import type { ConfidenceLevel, SearchResult } from '@copilotkit/outpost/ai';

/**
 * POST /api/qa
 *
 * Accepts a question and optional conversation history. Runs the full
 * AI pipeline (bounded investigation, verification, and formatting) and streams
 * the response back using Server-Sent Events.
 *
 * Request body: { question: string, conversationHistory?: Array<{ role, content }> }
 *
 * SSE events:
 *   data: { type: "token", text: "..." }      — streamed text chunks
 *   data: { type: "metadata", confidence, sources, latencyMs }  — final metadata
 *   data: [DONE]
 */
export async function POST(request: Request) {
    // Auth check
    const session = await getServerSession(authOptions);
    if (!session) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    let body: {
        question?: string;
        conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    };

    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const question = body.question?.trim();
    if (!question) {
        return new Response(JSON.stringify({ error: 'question is required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const pipeline = new AIPipeline();
    const startTime = Date.now();

    try {
        const stream = new ReadableStream({
            async start(controller) {
                const encoder = new TextEncoder();

                function sendEvent(data: string) {
                    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                }

                try {
                    const result = await pipeline.generateSupportResponse(question, {
                        source: 'web',
                        conversationHistory: body.conversationHistory,
                    });

                    // Stream the PUBLISHED text, not `result.response`.
                    //
                    // `response` is the model's raw draft and is internal — when the
                    // pipeline's groundedness gate suppresses it, `formatted` carries
                    // safe replacement copy while `response` still holds the draft
                    // for a human. Streaming `formatted.text` means this route
                    // inherits the gate instead of re-implementing it, so it never
                    // needs to read `suppressed`.
                    const text = result.formatted.text;
                    const chunkSize = 8;

                    for (let i = 0; i < text.length; i += chunkSize) {
                        const chunk = text.slice(i, i + chunkSize);
                        sendEvent(JSON.stringify({ type: 'token', text: chunk }));
                    }

                    // Send metadata
                    const latencyMs = Date.now() - startTime;
                    sendEvent(
                        JSON.stringify({
                            type: 'metadata',
                            details: result.formatted.details,
                            confidence: result.confidenceLevel as ConfidenceLevel,
                            sources: result.searchResults.map((s: SearchResult) => ({
                                title: s.title,
                                content: s.content,
                                score: s.score,
                                sourceUrl: s.sourceUrl,
                                category: s.category,
                            })),
                            latencyMs,
                        }),
                    );

                    sendEvent('[DONE]');
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : 'Pipeline error';
                    sendEvent(
                        JSON.stringify({
                            type: 'token',
                            text: `Sorry, I encountered an error: ${errorMsg}. Please try again.`,
                        }),
                    );
                    sendEvent(
                        JSON.stringify({
                            type: 'metadata',
                            confidence: 'LOW',
                            sources: [],
                            latencyMs: Date.now() - startTime,
                        }),
                    );
                    sendEvent('[DONE]');
                } finally {
                    controller.close();
                    pipeline.destroy();
                }
            },
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            },
        });
    } catch (error) {
        pipeline.destroy();
        const message = error instanceof Error ? error.message : 'Internal server error';
        return new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

import { AIPipeline } from '@outpost/ai';
import type { ConfidenceLevel, SearchResult } from '@outpost/ai';

/**
 * POST /api/qa
 *
 * Accepts a question and optional conversation history. Runs the full
 * AI pipeline (Pathfinder search + Claude generation) and streams
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
    let body: { question?: string; conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }> };

    try {
        body = await request.json();
    } catch {
        return new Response(
            JSON.stringify({ error: 'Invalid JSON body' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
    }

    const question = body.question?.trim();
    if (!question) {
        return new Response(
            JSON.stringify({ error: 'question is required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
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
                    // First, get the full pipeline result (includes sources + confidence)
                    // while streaming tokens
                    const result = await pipeline.generateSupportResponse(
                        question,
                        {
                            source: 'web',
                            conversationHistory: body.conversationHistory,
                        },
                    );

                    // Since the non-streaming pipeline returns the full response,
                    // we simulate streaming by chunking the response text.
                    // For a production setup, we'd use generateStreamingResponse
                    // and collect metadata separately.
                    const text = result.response;
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
                            confidence: result.confidence as ConfidenceLevel,
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
                    const errorMsg =
                        error instanceof Error ? error.message : 'Pipeline error';
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
        return new Response(
            JSON.stringify({ error: message }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
    }
}

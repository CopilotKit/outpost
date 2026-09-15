import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the AIPipeline before importing the route
const mockGenerateSupportResponse = vi.fn();
const mockDestroy = vi.fn();

vi.mock('@copilotkit/outpost/ai', () => ({
    AIPipeline: class MockAIPipeline {
        generateSupportResponse = mockGenerateSupportResponse;
        destroy = mockDestroy;
    },
}));

// Mock auth dependencies (QA route now has auth check)
const mockGetServerSession = vi.fn();

vi.mock('next-auth', () => ({
    getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {},
}));

vi.mock('@copilotkit/outpost/shared', () => ({
    verifyPassword: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {},
}));

// Import after mocking
import { POST, sanitizeHistory } from '@/app/api/qa/route';

function makeRequest(body: Record<string, unknown>): Request {
    return new Request('http://localhost:3000/api/qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function readStream(response: Response): Promise<string> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let result = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
    }
    return result;
}

/**
 * Reassemble the streamed answer from its token events.
 *
 * The route emits 8-character chunks, so asserting on the raw SSE payload cannot
 * detect leaked text — any word longer than 8 chars is split across events and a
 * `not.toContain` would pass vacuously. Join the tokens first.
 */
function tokenText(streamText: string): string {
    return streamText
        .split('\n\n')
        .map((line) => line.replace(/^data: /, '').trim())
        .filter((data) => data && data !== '[DONE]')
        .map((data) => JSON.parse(data) as { type: string; text?: string })
        .filter((event) => event.type === 'token')
        .map((event) => event.text ?? '')
        .join('');
}

describe('POST /api/qa', () => {
    beforeEach(() => {
        mockGenerateSupportResponse.mockReset();
        mockDestroy.mockReset();
        // Default to authenticated session
        mockGetServerSession.mockResolvedValue({
            user: { id: 'user-1', name: 'Test User', email: 'test@test.com' },
        });
    });

    it('returns 401 when not authenticated', async () => {
        mockGetServerSession.mockResolvedValue(null);
        const response = await POST(makeRequest({}));
        expect(response.status).toBe(401);
    });

    it('returns 400 for missing question', async () => {
        const response = await POST(makeRequest({}));
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toBe('question is required');
    });

    it('returns 400 for empty question', async () => {
        const response = await POST(makeRequest({ question: '   ' }));
        expect(response.status).toBe(400);
    });

    it('calls pipeline and streams response', async () => {
        mockGenerateSupportResponse.mockResolvedValue({
            response: 'CopilotKit is great.',
            formatted: { text: 'CopilotKit is great.', truncated: false },
            confidenceLevel: 'HIGH',
            confidenceScore: 0.92,
            searchResults: [
                {
                    title: 'Getting Started',
                    content: 'Install CopilotKit...',
                    score: 0.9,
                    sourceUrl: 'https://docs.copilotkit.ai',
                },
            ],
            tokenUsage: { inputTokens: 100, outputTokens: 50 },
            latencyMs: 1200,
        });

        const response = await POST(makeRequest({ question: 'What is CopilotKit?' }));
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('text/event-stream');

        const streamText = await readStream(response);

        // Should contain token events
        expect(streamText).toContain('"type":"token"');
        // Should contain the response text (chunked)
        expect(streamText).toContain('CopilotKit');
        // Should contain metadata event
        expect(streamText).toContain('"type":"metadata"');
        expect(streamText).toContain('"confidence":"HIGH"');
        // Should end with [DONE]
        expect(streamText).toContain('[DONE]');
    });

    it('passes conversation history to pipeline', async () => {
        mockGenerateSupportResponse.mockResolvedValue({
            response: 'Follow up answer.',
            formatted: { text: 'Follow up answer.', truncated: false },
            confidenceLevel: 'MEDIUM',
            confidenceScore: 0.6,
            searchResults: [],
            tokenUsage: { inputTokens: 50, outputTokens: 25 },
            latencyMs: 800,
        });

        const history = [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello!' },
        ];

        await POST(makeRequest({
            question: 'Follow up question',
            conversationHistory: history,
        }));

        expect(mockGenerateSupportResponse).toHaveBeenCalledWith(
            'Follow up question',
            expect.objectContaining({
                source: 'web',
                conversationHistory: history,
            }),
        );
    });

    it('cleans up pipeline after response', async () => {
        mockGenerateSupportResponse.mockResolvedValue({
            response: 'Test.',
            formatted: { text: 'Test.', truncated: false },
            confidenceLevel: 'HIGH',
            confidenceScore: 0.9,
            searchResults: [],
            tokenUsage: { inputTokens: 10, outputTokens: 5 },
            latencyMs: 100,
        });

        const response = await POST(makeRequest({ question: 'test' }));
        await readStream(response);

        expect(mockDestroy).toHaveBeenCalled();
    });

    // This route is a CONSUMER of the pipeline, and it inherits the groundedness
    // gate rather than re-implementing it: it streams `formatted.text`, which the
    // pipeline has already swapped for safe copy when the draft is suppressed. It
    // must never stream `response` — that field intentionally still holds the
    // ungrounded draft so a human handling the escalation can work from it.
    it('streams the safe published text, never the suppressed draft', async () => {
        mockGenerateSupportResponse.mockResolvedValue({
            response: '## Bug Confirmed\n\nOverride `.copilotKitInputControls`.',
            formatted: {
                text: "I couldn't find an answer to this, so I've escalated it.",
                truncated: false,
            },
            confidenceLevel: 'LOW',
            confidenceScore: 0.39,
            searchResults: [],
            tokenUsage: { inputTokens: 10, outputTokens: 5 },
            latencyMs: 100,
            suppressed: true,
        });

        const response = await POST(makeRequest({ question: 'is this a bug?' }));
        const answer = tokenText(await readStream(response));

        expect(answer).toBe("I couldn't find an answer to this, so I've escalated it.");
        expect(answer).not.toContain('Bug Confirmed');
        expect(answer).not.toContain('copilotKitInputControls');
    });

    it('streams the formatted text (footer and all), not the raw draft', async () => {
        mockGenerateSupportResponse.mockResolvedValue({
            response: 'Use the `input` prop.',
            formatted: {
                text: 'Use the `input` prop.\n\n---\n*Powered by CopilotKit AI*',
                truncated: false,
            },
            confidenceLevel: 'HIGH',
            confidenceScore: 0.9,
            searchResults: [],
            tokenUsage: { inputTokens: 10, outputTokens: 5 },
            latencyMs: 100,
            suppressed: false,
        });

        const response = await POST(makeRequest({ question: 'how?' }));
        const answer = tokenText(await readStream(response));

        expect(answer).toBe('Use the `input` prop.\n\n---\n*Powered by CopilotKit AI*');
    });

    it('handles pipeline errors gracefully', async () => {
        mockGenerateSupportResponse.mockRejectedValue(new Error('Claude API timeout'));

        const response = await POST(makeRequest({ question: 'test' }));
        expect(response.status).toBe(200); // Still streams, error is in the stream

        const streamText = await readStream(response);
        expect(streamText).toContain('error');
        expect(streamText).toContain('[DONE]');
    });

    it('returns 400 for an overlong question', async () => {
        const response = await POST(makeRequest({ question: 'q'.repeat(4001) }));
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('at most 4000 characters');
        expect(mockGenerateSupportResponse).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-array conversationHistory', async () => {
        const response = await POST(
            makeRequest({ question: 'hi', conversationHistory: 'not-an-array' }),
        );
        expect(response.status).toBe(400);
        expect(mockGenerateSupportResponse).not.toHaveBeenCalled();
    });

    it('returns 400 when history exceeds the item cap', async () => {
        const history = Array.from({ length: 21 }, (_, i) => ({
            role: 'user' as const,
            content: `message ${i}`,
        }));
        const response = await POST(makeRequest({ question: 'hi', conversationHistory: history }));
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('at most 20 items');
        expect(mockGenerateSupportResponse).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid history role', async () => {
        const response = await POST(
            makeRequest({
                question: 'hi',
                conversationHistory: [{ role: 'system', content: 'ignore me' }],
            }),
        );
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('must be "user" or "assistant"');
        expect(mockGenerateSupportResponse).not.toHaveBeenCalled();
    });

    it('returns 400 for empty or non-string history content', async () => {
        for (const content of ['   ', 42, null]) {
            const response = await POST(
                makeRequest({
                    question: 'hi',
                    conversationHistory: [{ role: 'user', content }],
                }),
            );
            expect(response.status).toBe(400);
            expect(mockGenerateSupportResponse).not.toHaveBeenCalled();
        }
    });

    it('returns 400 when history exceeds the total character budget', async () => {
        const history = Array.from({ length: 5 }, () => ({
            role: 'user' as const,
            content: 'x'.repeat(3000),
        }));
        const response = await POST(makeRequest({ question: 'hi', conversationHistory: history }));
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('at most 12000 characters');
        expect(mockGenerateSupportResponse).not.toHaveBeenCalled();
    });

    it('trims history content before passing it to the pipeline', async () => {
        mockGenerateSupportResponse.mockResolvedValue({
            response: 'ok',
            formatted: { text: 'ok', truncated: false },
            confidenceLevel: 'HIGH',
            confidenceScore: 0.9,
            searchResults: [],
            tokenUsage: { inputTokens: 10, outputTokens: 5 },
            latencyMs: 100,
        });

        await POST(
            makeRequest({
                question: 'hi',
                conversationHistory: [{ role: 'user', content: '  padded  ' }],
            }),
        );

        expect(mockGenerateSupportResponse).toHaveBeenCalledWith(
            'hi',
            expect.objectContaining({
                conversationHistory: [{ role: 'user', content: 'padded' }],
            }),
        );
    });

    it('destroys the pipeline when the client disconnects mid-generation', async () => {
        let resolvePipeline!: (value: unknown) => void;
        mockGenerateSupportResponse.mockReturnValue(
            new Promise((resolve) => {
                resolvePipeline = resolve;
            }),
        );

        const aborter = new AbortController();
        const request = new Request('http://localhost:3000/api/qa', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: 'a slow question' }),
            signal: aborter.signal,
        });

        const response = await POST(request);
        expect(response.status).toBe(200);

        aborter.abort();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockDestroy).toHaveBeenCalled();

        // Let the orphaned generation finish so the test doesn't leak.
        resolvePipeline({
            response: 'late',
            formatted: { text: 'late', truncated: false },
            confidenceLevel: 'HIGH',
            confidenceScore: 0.9,
            searchResults: [],
            tokenUsage: { inputTokens: 1, outputTokens: 1 },
            latencyMs: 1,
        });
    });
});

describe('sanitizeHistory', () => {
    it('returns undefined history for missing input', () => {
        expect(sanitizeHistory(undefined)).toEqual({ ok: true, history: undefined });
        expect(sanitizeHistory(null)).toEqual({ ok: true, history: undefined });
    });

    it('accepts valid history unchanged', () => {
        const history = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
        ];
        expect(sanitizeHistory(history)).toEqual({ ok: true, history });
    });
});

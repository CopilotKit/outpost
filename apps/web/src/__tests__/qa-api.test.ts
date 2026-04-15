import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the AIPipeline before importing the route
const mockGenerateSupportResponse = vi.fn();
const mockDestroy = vi.fn();

vi.mock('@outpost/ai', () => ({
    AIPipeline: class MockAIPipeline {
        generateSupportResponse = mockGenerateSupportResponse;
        destroy = mockDestroy;
    },
}));

// Import after mocking
import { POST } from '@/app/api/qa/route';

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

describe('POST /api/qa', () => {
    beforeEach(() => {
        mockGenerateSupportResponse.mockReset();
        mockDestroy.mockReset();
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
            confidence: 'HIGH',
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
            confidence: 'MEDIUM',
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
            confidence: 'HIGH',
            confidenceScore: 0.9,
            searchResults: [],
            tokenUsage: { inputTokens: 10, outputTokens: 5 },
            latencyMs: 100,
        });

        const response = await POST(makeRequest({ question: 'test' }));
        await readStream(response);

        expect(mockDestroy).toHaveBeenCalled();
    });

    it('handles pipeline errors gracefully', async () => {
        mockGenerateSupportResponse.mockRejectedValue(new Error('Claude API timeout'));

        const response = await POST(makeRequest({ question: 'test' }));
        expect(response.status).toBe(200); // Still streams, error is in the stream

        const streamText = await readStream(response);
        expect(streamText).toContain('error');
        expect(streamText).toContain('[DONE]');
    });
});

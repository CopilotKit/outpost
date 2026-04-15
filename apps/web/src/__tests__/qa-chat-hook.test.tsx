import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useQAChat } from '@/hooks/use-qa-chat';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

function createMockSSEResponse(events: string[]): Response {
    const text = events.join('\n\n') + '\n\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
    });
}

describe('useQAChat', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('starts with empty state', () => {
        const { result } = renderHook(() => useQAChat());

        expect(result.current.messages).toEqual([]);
        expect(result.current.loading).toBe(false);
        expect(result.current.streaming).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it('adds user message and streams AI response', async () => {
        mockFetch.mockResolvedValue(
            createMockSSEResponse([
                'data: {"type":"token","text":"Hello "}',
                'data: {"type":"token","text":"world!"}',
                'data: {"type":"metadata","confidence":"HIGH","sources":[],"latencyMs":500}',
                'data: [DONE]',
            ]),
        );

        const { result } = renderHook(() => useQAChat());

        await act(async () => {
            await result.current.sendMessage('Hi there');
        });

        await waitFor(() => {
            expect(result.current.loading).toBe(false);
        });

        // Should have user message + AI response
        expect(result.current.messages).toHaveLength(2);
        expect(result.current.messages[0].role).toBe('user');
        expect(result.current.messages[0].content).toBe('Hi there');
        expect(result.current.messages[1].role).toBe('assistant');
        expect(result.current.messages[1].content).toBe('Hello world!');
        expect(result.current.messages[1].confidence).toBe('HIGH');
    });

    it('maintains conversation history across messages', async () => {
        // First message
        mockFetch.mockResolvedValueOnce(
            createMockSSEResponse([
                'data: {"type":"token","text":"First answer"}',
                'data: {"type":"metadata","confidence":"HIGH","sources":[],"latencyMs":300}',
                'data: [DONE]',
            ]),
        );

        const { result } = renderHook(() => useQAChat());

        await act(async () => {
            await result.current.sendMessage('Question 1');
        });

        await waitFor(() => {
            expect(result.current.messages).toHaveLength(2);
        });

        // Second message
        mockFetch.mockResolvedValueOnce(
            createMockSSEResponse([
                'data: {"type":"token","text":"Second answer"}',
                'data: {"type":"metadata","confidence":"MEDIUM","sources":[],"latencyMs":400}',
                'data: [DONE]',
            ]),
        );

        await act(async () => {
            await result.current.sendMessage('Question 2');
        });

        await waitFor(() => {
            expect(result.current.messages).toHaveLength(4);
        });

        // The second API call should include conversation history
        const secondCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
        expect(secondCallBody.conversationHistory).toHaveLength(2);
        expect(secondCallBody.conversationHistory[0].role).toBe('user');
        expect(secondCallBody.conversationHistory[0].content).toBe('Question 1');
        expect(secondCallBody.conversationHistory[1].role).toBe('assistant');
        expect(secondCallBody.conversationHistory[1].content).toBe('First answer');
    });

    it('clears conversation', async () => {
        mockFetch.mockResolvedValue(
            createMockSSEResponse([
                'data: {"type":"token","text":"Answer"}',
                'data: {"type":"metadata","confidence":"HIGH","sources":[],"latencyMs":200}',
                'data: [DONE]',
            ]),
        );

        const { result } = renderHook(() => useQAChat());

        await act(async () => {
            await result.current.sendMessage('Test');
        });

        await waitFor(() => {
            expect(result.current.messages).toHaveLength(2);
        });

        act(() => {
            result.current.clearConversation();
        });

        expect(result.current.messages).toEqual([]);
        expect(result.current.loading).toBe(false);
    });

    it('handles API errors gracefully', async () => {
        mockFetch.mockResolvedValue(
            new Response(JSON.stringify({ error: 'Server error' }), {
                status: 500,
            }),
        );

        const { result } = renderHook(() => useQAChat());

        await act(async () => {
            await result.current.sendMessage('Bad request');
        });

        await waitFor(() => {
            expect(result.current.loading).toBe(false);
        });

        // Should still have messages but with error state
        expect(result.current.messages).toHaveLength(2);
        expect(result.current.messages[1].content).toContain('something went wrong');
    });
});

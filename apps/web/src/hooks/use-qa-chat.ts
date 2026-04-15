'use client';

import { useState, useCallback, useRef } from 'react';
import type { ChatMessageData } from '@/components/qa/chat-message';
import type { ConfidenceLevel } from '@/components/qa/confidence-badge';
import type { SourceItem } from '@/components/qa/source-panel';

interface QAChatState {
    messages: ChatMessageData[];
    loading: boolean;
    streaming: boolean;
    error: string | null;
}

interface StreamMetadata {
    confidence?: ConfidenceLevel;
    sources?: SourceItem[];
    latencyMs?: number;
}

let nextMessageId = 1;

function generateMessageId(): string {
    return `msg-${Date.now()}-${nextMessageId++}`;
}

export function useQAChat() {
    const [state, setState] = useState<QAChatState>({
        messages: [],
        loading: false,
        streaming: false,
        error: null,
    });
    const abortControllerRef = useRef<AbortController | null>(null);

    const sendMessage = useCallback(async (text: string) => {
        const userMessage: ChatMessageData = {
            id: generateMessageId(),
            role: 'user',
            content: text,
        };

        const assistantMessageId = generateMessageId();
        const assistantMessage: ChatMessageData = {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            streaming: true,
        };

        setState((prev) => ({
            ...prev,
            messages: [...prev.messages, userMessage, assistantMessage],
            loading: true,
            streaming: true,
            error: null,
        }));

        // Build conversation history from previous messages (exclude the current exchange)
        const conversationHistory = state.messages
            .filter((m) => !m.streaming)
            .map((m) => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
            }));

        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        try {
            const response = await fetch('/api/qa', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    question: text,
                    conversationHistory,
                }),
                signal: abortController.signal,
            });

            if (!response.ok) {
                throw new Error(`API returned ${response.status}`);
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error('No response body');
            }

            const decoder = new TextDecoder();
            let fullContent = '';
            let metadata: StreamMetadata = {};

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6);

                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.type === 'token') {
                            fullContent += parsed.text;
                            setState((prev) => ({
                                ...prev,
                                messages: prev.messages.map((m) =>
                                    m.id === assistantMessageId
                                        ? { ...m, content: fullContent }
                                        : m,
                                ),
                            }));
                        } else if (parsed.type === 'metadata') {
                            metadata = {
                                confidence: parsed.confidence,
                                sources: parsed.sources,
                                latencyMs: parsed.latencyMs,
                            };
                        }
                    } catch {
                        // Skip malformed JSON lines
                    }
                }
            }

            // Finalize the message with metadata
            setState((prev) => ({
                ...prev,
                messages: prev.messages.map((m) =>
                    m.id === assistantMessageId
                        ? {
                              ...m,
                              content: fullContent,
                              streaming: false,
                              confidence: metadata.confidence,
                              sources: metadata.sources,
                              latencyMs: metadata.latencyMs,
                          }
                        : m,
                ),
                loading: false,
                streaming: false,
            }));
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                setState((prev) => ({
                    ...prev,
                    messages: prev.messages.filter((m) => m.id !== assistantMessageId),
                    loading: false,
                    streaming: false,
                }));
                return;
            }

            const errorMessage =
                error instanceof Error ? error.message : 'An unexpected error occurred';

            setState((prev) => ({
                ...prev,
                messages: prev.messages.map((m) =>
                    m.id === assistantMessageId
                        ? {
                              ...m,
                              content:
                                  'Sorry, something went wrong generating a response. Please try again.',
                              streaming: false,
                              confidence: 'LOW' as ConfidenceLevel,
                          }
                        : m,
                ),
                loading: false,
                streaming: false,
                error: errorMessage,
            }));
        }
    }, [state.messages]);

    const clearConversation = useCallback(() => {
        abortControllerRef.current?.abort();
        setState({
            messages: [],
            loading: false,
            streaming: false,
            error: null,
        });
    }, []);

    return {
        messages: state.messages,
        loading: state.loading,
        streaming: state.streaming,
        error: state.error,
        sendMessage,
        clearConversation,
    };
}

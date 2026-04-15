'use client';

import { useRef, useEffect } from 'react';
import { MessageSquare, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { ChatMessage } from '@/components/qa/chat-message';
import { ChatInput } from '@/components/qa/chat-input';
import { useQAChat } from '@/hooks/use-qa-chat';
import { cn } from '@/lib/utils';

export default function QAPage() {
    const { messages, loading, streaming, sendMessage, clearConversation } =
        useQAChat();
    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom when messages change
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    return (
        <div className="flex h-full flex-col -m-6 -mb-6">
            {/* Header */}
            <div className="shrink-0 border-b border-border px-6 pt-6">
                <div className="flex items-center justify-between mb-4">
                    <PageHeader
                        title="Ask AI"
                        description="Ask questions about CopilotKit and AG-UI. Copy answers into support threads."
                        icon={MessageSquare}
                        breadcrumbs={[{ label: 'Ask AI' }]}
                    />
                    {messages.length > 0 && (
                        <button
                            onClick={clearConversation}
                            className={cn(
                                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm',
                                'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                                'transition-colors',
                            )}
                        >
                            <Trash2 className="h-4 w-4" />
                            <span>Clear</span>
                        </button>
                    )}
                </div>
            </div>

            {/* Messages area */}
            <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto"
            >
                {messages.length === 0 ? (
                    <div className="flex h-full items-center justify-center">
                        <div className="text-center max-w-md px-4">
                            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary mb-4">
                                <MessageSquare className="h-8 w-8" />
                            </div>
                            <h2 className="text-lg font-semibold text-foreground mb-2">
                                Internal Q&A Console
                            </h2>
                            <p className="text-sm text-muted-foreground mb-4">
                                Ask questions about CopilotKit, AG-UI, CoAgents, or any part of the platform.
                                Responses are generated from our documentation using Pathfinder + Claude.
                            </p>
                            <div className="space-y-2 text-left">
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                    Try asking
                                </p>
                                {[
                                    'How do I set up CopilotKit with Next.js?',
                                    'What is the difference between useCopilotAction and useCopilotReadable?',
                                    'How does AG-UI protocol handle streaming events?',
                                ].map((suggestion) => (
                                    <button
                                        key={suggestion}
                                        onClick={() => sendMessage(suggestion)}
                                        className={cn(
                                            'block w-full rounded-lg border border-border/50 px-3 py-2 text-left text-sm',
                                            'text-muted-foreground hover:text-foreground hover:border-border',
                                            'transition-colors',
                                        )}
                                    >
                                        {suggestion}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="max-w-3xl mx-auto divide-y divide-border/30">
                        {messages.map((message) => (
                            <ChatMessage key={message.id} message={message} />
                        ))}
                    </div>
                )}
            </div>

            {/* Input area */}
            <div className="shrink-0">
                <ChatInput
                    onSend={sendMessage}
                    disabled={loading || streaming}
                />
            </div>
        </div>
    );
}

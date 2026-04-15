'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { User, Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ConfidenceBadge } from './confidence-badge';
import type { ConfidenceLevel } from './confidence-badge';
import { CopyButton } from './copy-button';
import { SourcePanel } from './source-panel';
import type { SourceItem } from './source-panel';

export interface ChatMessageData {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    confidence?: ConfidenceLevel;
    sources?: SourceItem[];
    latencyMs?: number;
    streaming?: boolean;
}

interface ChatMessageProps {
    message: ChatMessageData;
}

export function ChatMessage({ message }: ChatMessageProps) {
    const isUser = message.role === 'user';

    return (
        <div
            data-testid={`chat-message-${message.role}`}
            className={cn(
                'flex gap-3 px-4 py-4',
                isUser ? 'bg-transparent' : 'bg-muted/20',
            )}
        >
            {/* Avatar */}
            <div
                className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                    isUser
                        ? 'bg-primary/10 text-primary'
                        : 'bg-accent text-accent-foreground',
                )}
            >
                {isUser ? (
                    <User className="h-4 w-4" />
                ) : (
                    <Bot className="h-4 w-4" />
                )}
            </div>

            {/* Content */}
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-foreground">
                        {isUser ? 'You' : 'Outpost AI'}
                    </span>
                    {!isUser && message.confidence && (
                        <ConfidenceBadge level={message.confidence} />
                    )}
                    {!isUser && message.latencyMs !== undefined && (
                        <span className="text-xs text-muted-foreground">
                            {(message.latencyMs / 1000).toFixed(1)}s
                        </span>
                    )}
                </div>

                {isUser ? (
                    <p className="text-sm text-foreground whitespace-pre-wrap">
                        {message.content}
                    </p>
                ) : (
                    <div className="prose prose-sm prose-invert max-w-none text-foreground">
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                                a: ({ children, href, ...props }) => (
                                    <a
                                        href={href}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-primary hover:text-primary/80 underline"
                                        {...props}
                                    >
                                        {children}
                                    </a>
                                ),
                                code: ({ children, className, ...props }) => {
                                    const isInline = !className;
                                    if (isInline) {
                                        return (
                                            <code
                                                className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-foreground"
                                                {...props}
                                            >
                                                {children}
                                            </code>
                                        );
                                    }
                                    return (
                                        <div className="relative group">
                                            <CopyButton
                                                text={String(children).replace(/\n$/, '')}
                                                className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity"
                                                label="Copy code"
                                            />
                                            <code className={className} {...props}>
                                                {children}
                                            </code>
                                        </div>
                                    );
                                },
                                pre: ({ children, ...props }) => (
                                    <pre
                                        className="rounded-lg bg-muted/50 p-3 overflow-x-auto text-xs"
                                        {...props}
                                    >
                                        {children}
                                    </pre>
                                ),
                            }}
                        >
                            {message.content}
                        </ReactMarkdown>
                        {message.streaming && (
                            <span className="inline-block w-2 h-4 bg-primary/60 animate-pulse ml-0.5" />
                        )}
                    </div>
                )}

                {/* Actions for AI messages */}
                {!isUser && !message.streaming && message.content && (
                    <div className="mt-2 flex items-center gap-2">
                        <CopyButton text={message.content} label="Copy response" />
                    </div>
                )}

                {/* Source panel for AI messages */}
                {!isUser && message.sources && message.sources.length > 0 && (
                    <SourcePanel sources={message.sources} />
                )}
            </div>
        </div>
    );
}

'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Send } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ChatInputProps {
    onSend: (message: string) => void;
    disabled?: boolean;
    placeholder?: string;
}

export function ChatInput({
    onSend,
    disabled = false,
    placeholder = 'Ask a question about CopilotKit or AG-UI...',
}: ChatInputProps) {
    const [value, setValue] = useState('');
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Auto-resize textarea
    useEffect(() => {
        const textarea = textareaRef.current;
        if (textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
        }
    }, [value]);

    const handleSubmit = useCallback(() => {
        const trimmed = value.trim();
        if (!trimmed || disabled) return;
        onSend(trimmed);
        setValue('');
        // Reset height after clearing
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
        }
    }, [value, disabled, onSend]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
            }
        },
        [handleSubmit],
    );

    return (
        <div
            data-testid="chat-input"
            className="border-t border-border bg-card px-4 py-3"
        >
            <div className="flex items-end gap-2 max-w-3xl mx-auto">
                <textarea
                    ref={textareaRef}
                    data-testid="chat-input-textarea"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    disabled={disabled}
                    rows={1}
                    className={cn(
                        'flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2',
                        'text-sm text-foreground placeholder:text-muted-foreground',
                        'focus:outline-none focus:ring-2 focus:ring-ring/50',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                />
                <button
                    data-testid="chat-send-button"
                    onClick={handleSubmit}
                    disabled={disabled || !value.trim()}
                    className={cn(
                        'flex h-9 w-9 items-center justify-center rounded-lg',
                        'bg-primary text-primary-foreground',
                        'hover:bg-primary/90 transition-colors',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                    )}
                >
                    <Send className="h-4 w-4" />
                </button>
            </div>
            <p className="mt-1 text-center text-xs text-muted-foreground max-w-3xl mx-auto">
                AI responses are generated from CopilotKit docs. Always verify before sharing.
            </p>
        </div>
    );
}

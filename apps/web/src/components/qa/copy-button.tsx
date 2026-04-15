'use client';

import { useState, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CopyButtonProps {
    text: string;
    className?: string;
    label?: string;
}

export function CopyButton({ text, className, label = 'Copy' }: CopyButtonProps) {
    const [copied, setCopied] = useState(false);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Fallback for environments without clipboard API
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    }, [text]);

    return (
        <button
            data-testid="copy-button"
            onClick={handleCopy}
            className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs',
                'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                'transition-colors',
                className,
            )}
            title={copied ? 'Copied!' : label}
        >
            {copied ? (
                <>
                    <Check className="h-3.5 w-3.5 text-green-400" />
                    <span>Copied!</span>
                </>
            ) : (
                <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>{label}</span>
                </>
            )}
        </button>
    );
}

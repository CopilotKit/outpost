'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SourceItem {
    title: string;
    content: string;
    score: number;
    sourceUrl?: string;
    category?: string;
}

interface SourcePanelProps {
    sources: SourceItem[];
    className?: string;
}

export function SourcePanel({ sources, className }: SourcePanelProps) {
    const [expanded, setExpanded] = useState(false);

    if (sources.length === 0) {
        return null;
    }

    return (
        <div
            data-testid="source-panel"
            className={cn('mt-2 rounded-md border border-border/50', className)}
        >
            <button
                onClick={() => setExpanded(!expanded)}
                className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground',
                    'hover:text-foreground transition-colors',
                )}
            >
                {expanded ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                )}
                <span>{sources.length} source{sources.length !== 1 ? 's' : ''}</span>
            </button>

            {expanded && (
                <div className="border-t border-border/50 px-3 py-2 space-y-2">
                    {sources.map((source, index) => (
                        <div
                            key={index}
                            className="rounded bg-muted/30 px-3 py-2 text-xs"
                        >
                            <div className="flex items-center justify-between gap-2 mb-1">
                                <span className="font-medium text-foreground">
                                    {source.title}
                                </span>
                                <div className="flex items-center gap-2">
                                    <span className="text-muted-foreground">
                                        {Math.round(source.score * 100)}% relevant
                                    </span>
                                    {source.sourceUrl && (
                                        <a
                                            href={source.sourceUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-primary hover:text-primary/80"
                                        >
                                            <ExternalLink className="h-3 w-3" />
                                        </a>
                                    )}
                                </div>
                            </div>
                            <p className="text-muted-foreground line-clamp-3">
                                {source.content}
                            </p>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

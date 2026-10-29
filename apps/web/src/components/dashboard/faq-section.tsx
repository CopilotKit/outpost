'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FaqEntry {
    id: string;
    question: string;
    answer: string;
    sourceCount: number;
}

interface FaqSectionProps {
    entries?: FaqEntry[];
}

export function FaqSection({ entries: initialEntries }: FaqSectionProps) {
    const [entries, setEntries] = useState<FaqEntry[]>(initialEntries ?? []);
    const [loading, setLoading] = useState(!initialEntries);
    const [loadFailed, setLoadFailed] = useState(false);
    const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (initialEntries) return;

        async function fetchFaq() {
            try {
                const res = await fetch('/api/dashboard/faq');
                // Show an error, never the "No FAQs available yet" empty state, when the list
                // did not load. A 401 lands here too: SessionGuard redirects to /login on its
                // next session read (mount or window focus); this response does not trigger that.
                if (!res.ok) {
                    setLoadFailed(true);
                    return;
                }
                const data = await res.json();
                setEntries(data.entries);
            } catch {
                setLoadFailed(true);
            } finally {
                setLoading(false);
            }
        }
        fetchFaq();
    }, [initialEntries]);

    function toggleSources(id: string) {
        setExpandedSources((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }

    return (
        <div className="rounded-lg border border-border bg-card p-6">
            <div className="mb-4 flex items-center gap-2">
                <BookOpen className="h-5 w-5 text-primary" />
                <h3 className="text-lg font-semibold text-card-foreground">Frequently Asked</h3>
            </div>

            {loading ? (
                <p className="text-sm text-muted-foreground">Loading FAQ...</p>
            ) : loadFailed ? (
                <p className="text-sm text-destructive" role="alert" data-testid="faq-error">
                    Couldn&apos;t load FAQs. Reload the page to try again.
                </p>
            ) : entries.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="faq-empty">
                    No FAQs available yet. FAQs are automatically generated from support
                    conversations.
                </p>
            ) : (
                <div className="space-y-3">
                    {entries.map((entry) => {
                        const isExpanded = expandedSources.has(entry.id);
                        return (
                            <div key={entry.id} className="rounded-md border border-border/50 p-4">
                                <h4 className="text-sm font-medium text-card-foreground">
                                    {entry.question}
                                </h4>
                                <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                                    {entry.answer}
                                </p>
                                <button
                                    onClick={() => toggleSources(entry.id)}
                                    className={cn(
                                        'mt-2 flex items-center gap-1 text-xs',
                                        'text-muted-foreground hover:text-foreground transition-colors',
                                    )}
                                    aria-expanded={isExpanded}
                                    aria-label={`Toggle sources for: ${entry.question}`}
                                >
                                    {isExpanded ? (
                                        <ChevronDown className="h-3 w-3" />
                                    ) : (
                                        <ChevronRight className="h-3 w-3" />
                                    )}
                                    {entry.sourceCount} source{entry.sourceCount !== 1 ? 's' : ''}
                                </button>
                                {isExpanded && (
                                    <div className="mt-2 rounded bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                                        {entry.sourceCount} knowledge base article
                                        {entry.sourceCount !== 1 ? 's' : ''} matched this question.
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

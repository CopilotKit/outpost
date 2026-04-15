'use client';

import { useState, useMemo } from 'react';
import {
    type PendingMessage,
    type MessageSortKey,
    type MessageFilters,
    MessageStatus,
    checkUnansweredMessages,
} from '@outpost/shared';
import { MessageCard } from './message-card';
import { MessageFiltersBar } from './message-filters';
import { Mail } from 'lucide-react';
import { PageHeader } from '@/components/page-header';

interface MessageInboxProps {
    messages: PendingMessage[];
}

function applyFilters(messages: PendingMessage[], filters: MessageFilters): PendingMessage[] {
    return messages.filter((msg) => {
        if (filters.source && msg.source !== filters.source) return false;
        if (filters.status && msg.status !== filters.status) return false;
        if (filters.accountId && msg.accountId !== filters.accountId) return false;
        return true;
    });
}

function applySort(messages: PendingMessage[], sortKey: MessageSortKey): PendingMessage[] {
    const sorted = [...messages];
    switch (sortKey) {
        case 'recent':
            sorted.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
            break;
        case 'oldest_unanswered':
            sorted.sort((a, b) => {
                // Unanswered first, then by oldest
                if (a.status === MessageStatus.UNANSWERED && b.status !== MessageStatus.UNANSWERED) return -1;
                if (a.status !== MessageStatus.UNANSWERED && b.status === MessageStatus.UNANSWERED) return 1;
                return new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime();
            });
            break;
        case 'acv':
            sorted.sort((a, b) => b.accountAcv - a.accountAcv);
            break;
    }
    return sorted;
}

export function MessageInbox({ messages }: MessageInboxProps) {
    const [filters, setFilters] = useState<MessageFilters>({});
    const [sortKey, setSortKey] = useState<MessageSortKey>('recent');

    const accountOptions = useMemo(() => {
        const seen = new Map<string, string>();
        for (const msg of messages) {
            if (!seen.has(msg.accountId)) {
                seen.set(msg.accountId, msg.accountName);
            }
        }
        return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
    }, [messages]);

    const filtered = useMemo(() => applyFilters(messages, filters), [messages, filters]);
    const sorted = useMemo(() => applySort(filtered, sortKey), [filtered, sortKey]);

    const overdueCount = useMemo(() => checkUnansweredMessages(messages).length, [messages]);
    const unansweredCount = messages.filter((m) => m.status === MessageStatus.UNANSWERED).length;

    return (
        <div data-testid="message-inbox">
            <PageHeader
                title="Messages"
                description="Unified inbox for Slack Connect and MS Teams customer channels"
                icon={Mail}
            />

            {/* Stats bar */}
            <div className="mb-4 flex items-center gap-4 text-sm">
                <span className="text-muted-foreground">
                    <span className="font-medium text-foreground">{unansweredCount}</span> unanswered
                </span>
                {overdueCount > 0 && (
                    <span className="text-red-600 dark:text-red-400 font-medium">
                        {overdueCount} overdue (&gt;4h)
                    </span>
                )}
                <span className="text-muted-foreground">
                    <span className="font-medium text-foreground">{messages.length}</span> total
                </span>
            </div>

            {/* Filters */}
            <div className="mb-4">
                <MessageFiltersBar
                    filters={filters}
                    sortKey={sortKey}
                    onFiltersChange={setFilters}
                    onSortChange={setSortKey}
                    accountOptions={accountOptions}
                />
            </div>

            {/* Message list */}
            <div className="space-y-3 max-h-[calc(100vh-320px)] overflow-y-auto pr-1">
                {sorted.length === 0 ? (
                    <div className="py-12 text-center text-sm text-muted-foreground">
                        No messages match your filters.
                    </div>
                ) : (
                    sorted.map((msg) => (
                        <MessageCard key={msg.id} message={msg} />
                    ))
                )}
            </div>
        </div>
    );
}

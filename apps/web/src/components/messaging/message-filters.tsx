'use client';

import {
    MessageSource,
    MessageStatus,
    type MessageSortKey,
    type MessageFilters,
} from '@outpost/shared';

interface MessageFiltersBarProps {
    filters: MessageFilters;
    sortKey: MessageSortKey;
    onFiltersChange: (filters: MessageFilters) => void;
    onSortChange: (sort: MessageSortKey) => void;
    accountOptions: { id: string; name: string }[];
}

export function MessageFiltersBar({
    filters,
    sortKey,
    onFiltersChange,
    onSortChange,
    accountOptions,
}: MessageFiltersBarProps) {
    return (
        <div data-testid="message-filters" className="flex flex-wrap items-center gap-3">
            {/* Source filter */}
            <select
                data-testid="filter-source"
                value={filters.source ?? ''}
                onChange={(e) =>
                    onFiltersChange({
                        ...filters,
                        source: (e.target.value as MessageSource) || undefined,
                    })
                }
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
            >
                <option value="">All Sources</option>
                <option value={MessageSource.SLACK}>Slack</option>
                <option value={MessageSource.TEAMS}>Teams</option>
            </select>

            {/* Status filter */}
            <select
                data-testid="filter-status"
                value={filters.status ?? ''}
                onChange={(e) =>
                    onFiltersChange({
                        ...filters,
                        status: (e.target.value as MessageStatus) || undefined,
                    })
                }
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
            >
                <option value="">All Statuses</option>
                <option value={MessageStatus.UNANSWERED}>Unanswered</option>
                <option value={MessageStatus.ANSWERED}>Answered</option>
            </select>

            {/* Account filter */}
            <select
                data-testid="filter-account"
                value={filters.accountId ?? ''}
                onChange={(e) =>
                    onFiltersChange({
                        ...filters,
                        accountId: e.target.value || undefined,
                    })
                }
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
            >
                <option value="">All Accounts</option>
                {accountOptions.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                        {acc.name}
                    </option>
                ))}
            </select>

            {/* Sort */}
            <select
                data-testid="sort-select"
                value={sortKey}
                onChange={(e) => onSortChange(e.target.value as MessageSortKey)}
                className="ml-auto rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
            >
                <option value="recent">Most Recent</option>
                <option value="oldest_unanswered">Oldest Unanswered</option>
                <option value="acv">Account Priority (ACV)</option>
            </select>
        </div>
    );
}

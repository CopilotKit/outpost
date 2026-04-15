'use client';

import {
    type PendingMessage,
    MessageSource,
    MessageStatus,
    getUrgencyLevel,
    getUnansweredDurationMs,
    formatMessageDuration,
} from '@outpost/shared';
import { cn } from '@/lib/utils';
import { UrgencyBadge } from './urgency-badge';

interface MessageCardProps {
    message: PendingMessage;
    now?: Date;
}

function SourceIcon({ source }: { source: MessageSource }) {
    if (source === MessageSource.SLACK) {
        return (
            <span
                data-testid="source-slack"
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 text-sm font-bold"
                title="Slack"
            >
                S
            </span>
        );
    }
    return (
        <span
            data-testid="source-teams"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 text-sm font-bold"
            title="MS Teams"
        >
            T
        </span>
    );
}

export function MessageCard({ message, now = new Date() }: MessageCardProps) {
    const urgency = getUrgencyLevel(message, now);
    const durationMs = getUnansweredDurationMs(message, now);
    const durationLabel = formatMessageDuration(durationMs);
    const isAnswered = message.status === MessageStatus.ANSWERED;

    return (
        <div
            data-testid="message-card"
            className={cn(
                'rounded-lg border p-4 transition-colors hover:bg-muted/50',
                isAnswered
                    ? 'border-border bg-muted/20 opacity-75'
                    : 'border-border bg-card',
            )}
        >
            <div className="flex items-start gap-3">
                <SourceIcon source={message.source} />

                <div className="min-w-0 flex-1">
                    {/* Header row */}
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                            <span className="font-semibold text-sm text-foreground truncate">
                                {message.customerName}
                            </span>
                            <span className="text-xs text-muted-foreground truncate">
                                {message.accountName}
                            </span>
                        </div>
                        {!isAnswered && (
                            <UrgencyBadge level={urgency} durationLabel={durationLabel} />
                        )}
                        {isAnswered && (
                            <span className="text-xs text-muted-foreground whitespace-nowrap">
                                Answered
                            </span>
                        )}
                    </div>

                    {/* Channel */}
                    <div className="mt-0.5 text-xs text-muted-foreground">
                        {message.channelName}
                    </div>

                    {/* Message preview */}
                    <p className="mt-1.5 text-sm text-foreground/80 line-clamp-2">
                        {message.messagePreview}
                    </p>

                    {/* Footer */}
                    <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                        <span>ACV ${(message.accountAcv / 1000).toFixed(0)}k</span>
                        <span>&middot;</span>
                        <span>{new Date(message.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

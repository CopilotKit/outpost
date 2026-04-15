'use client';

import { UrgencyLevel } from '@outpost/shared';
import { cn } from '@/lib/utils';

interface UrgencyBadgeProps {
    level: UrgencyLevel;
    durationLabel: string;
}

const urgencyStyles: Record<UrgencyLevel, string> = {
    [UrgencyLevel.LOW]: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    [UrgencyLevel.MEDIUM]: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
    [UrgencyLevel.HIGH]: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
};

const urgencyLabels: Record<UrgencyLevel, string> = {
    [UrgencyLevel.LOW]: 'Recent',
    [UrgencyLevel.MEDIUM]: 'Waiting',
    [UrgencyLevel.HIGH]: 'Overdue',
};

export function UrgencyBadge({ level, durationLabel }: UrgencyBadgeProps) {
    return (
        <span
            data-testid="urgency-badge"
            data-urgency={level}
            className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                urgencyStyles[level],
            )}
        >
            {level === UrgencyLevel.HIGH && (
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
            )}
            {urgencyLabels[level]} &middot; {durationLabel}
        </span>
    );
}

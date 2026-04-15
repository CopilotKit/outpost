'use client';

import { cn } from '@/lib/utils';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

interface ConfidenceBadgeProps {
    level: ConfidenceLevel;
    className?: string;
}

const badgeStyles: Record<ConfidenceLevel, string> = {
    HIGH: 'bg-green-500/15 text-green-400 border-green-500/30',
    MEDIUM: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    LOW: 'bg-red-500/15 text-red-400 border-red-500/30',
};

const badgeLabels: Record<ConfidenceLevel, string> = {
    HIGH: 'High confidence',
    MEDIUM: 'Medium confidence',
    LOW: 'Low confidence',
};

export function ConfidenceBadge({ level, className }: ConfidenceBadgeProps) {
    return (
        <span
            data-testid="confidence-badge"
            data-level={level}
            className={cn(
                'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                badgeStyles[level],
                className,
            )}
        >
            {badgeLabels[level]}
        </span>
    );
}

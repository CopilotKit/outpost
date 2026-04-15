/**
 * Messaging urgency checker.
 * Determines urgency level and finds overdue messages (unanswered > 4 hours).
 */

import {
    type PendingMessage,
    MessageStatus,
    UrgencyLevel,
} from './types.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * ONE_HOUR_MS;

/**
 * Calculate the urgency level for a pending message based on how long
 * it has gone unanswered.
 */
export function getUrgencyLevel(message: PendingMessage, now: Date = new Date()): UrgencyLevel {
    if (message.status === MessageStatus.ANSWERED) {
        return UrgencyLevel.LOW;
    }

    const elapsed = now.getTime() - new Date(message.receivedAt).getTime();

    if (elapsed > FOUR_HOURS_MS) {
        return UrgencyLevel.HIGH;
    }
    if (elapsed > ONE_HOUR_MS) {
        return UrgencyLevel.MEDIUM;
    }
    return UrgencyLevel.LOW;
}

/**
 * How many milliseconds a message has been unanswered.
 */
export function getUnansweredDurationMs(message: PendingMessage, now: Date = new Date()): number {
    if (message.status === MessageStatus.ANSWERED && message.answeredAt) {
        return new Date(message.answeredAt).getTime() - new Date(message.receivedAt).getTime();
    }
    return now.getTime() - new Date(message.receivedAt).getTime();
}

/**
 * Return all messages that have been unanswered for more than 4 hours.
 */
export function checkUnansweredMessages(
    messages: PendingMessage[],
    now: Date = new Date(),
): PendingMessage[] {
    return messages.filter((msg) => {
        if (msg.status !== MessageStatus.UNANSWERED) {
            return false;
        }
        const elapsed = now.getTime() - new Date(msg.receivedAt).getTime();
        return elapsed > FOUR_HOURS_MS;
    });
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * e.g. "2h 15m", "45m", "6h 0m"
 */
export function formatMessageDuration(ms: number): string {
    const totalMinutes = Math.floor(ms / (60 * 1000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours === 0) {
        return `${minutes}m`;
    }
    return `${hours}h ${minutes}m`;
}

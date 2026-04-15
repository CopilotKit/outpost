import { describe, it, expect } from 'vitest';
import {
    getUrgencyLevel,
    getUnansweredDurationMs,
    checkUnansweredMessages,
    formatMessageDuration,
} from '../checker.js';
import {
    type PendingMessage,
    MessageSource,
    MessageStatus,
    UrgencyLevel,
} from '../types.js';

function makeMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
    return {
        id: 'msg-test',
        customerName: 'Test Customer',
        accountId: 'acc-test',
        accountName: 'Test Corp',
        accountAcv: 100000,
        source: MessageSource.SLACK,
        channelName: '#test-channel',
        messagePreview: 'Test message preview',
        receivedAt: new Date().toISOString(),
        status: MessageStatus.UNANSWERED,
        ...overrides,
    };
}

function hoursAgoFrom(now: Date, hours: number): string {
    return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

describe('getUrgencyLevel', () => {
    const now = new Date('2026-04-15T12:00:00Z');

    it('returns LOW for messages under 1 hour old', () => {
        const msg = makeMessage({ receivedAt: hoursAgoFrom(now, 0.5) });
        expect(getUrgencyLevel(msg, now)).toBe(UrgencyLevel.LOW);
    });

    it('returns MEDIUM for messages 1-4 hours old', () => {
        const msg = makeMessage({ receivedAt: hoursAgoFrom(now, 2) });
        expect(getUrgencyLevel(msg, now)).toBe(UrgencyLevel.MEDIUM);
    });

    it('returns HIGH for messages over 4 hours old', () => {
        const msg = makeMessage({ receivedAt: hoursAgoFrom(now, 5) });
        expect(getUrgencyLevel(msg, now)).toBe(UrgencyLevel.HIGH);
    });

    it('returns LOW for answered messages regardless of age', () => {
        const msg = makeMessage({
            receivedAt: hoursAgoFrom(now, 10),
            status: MessageStatus.ANSWERED,
            answeredAt: hoursAgoFrom(now, 9),
        });
        expect(getUrgencyLevel(msg, now)).toBe(UrgencyLevel.LOW);
    });

    it('returns MEDIUM at exactly 1 hour boundary (just over)', () => {
        const msg = makeMessage({
            receivedAt: new Date(now.getTime() - 61 * 60 * 1000).toISOString(),
        });
        expect(getUrgencyLevel(msg, now)).toBe(UrgencyLevel.MEDIUM);
    });

    it('returns HIGH at exactly 4 hour boundary (just over)', () => {
        const msg = makeMessage({
            receivedAt: new Date(now.getTime() - 241 * 60 * 1000).toISOString(),
        });
        expect(getUrgencyLevel(msg, now)).toBe(UrgencyLevel.HIGH);
    });
});

describe('getUnansweredDurationMs', () => {
    const now = new Date('2026-04-15T12:00:00Z');

    it('returns elapsed time for unanswered messages', () => {
        const twoHoursMs = 2 * 60 * 60 * 1000;
        const msg = makeMessage({ receivedAt: hoursAgoFrom(now, 2) });
        const duration = getUnansweredDurationMs(msg, now);
        expect(Math.abs(duration - twoHoursMs)).toBeLessThan(1000);
    });

    it('returns response time for answered messages', () => {
        const msg = makeMessage({
            receivedAt: hoursAgoFrom(now, 3),
            status: MessageStatus.ANSWERED,
            answeredAt: hoursAgoFrom(now, 2),
        });
        const duration = getUnansweredDurationMs(msg, now);
        const oneHourMs = 60 * 60 * 1000;
        expect(Math.abs(duration - oneHourMs)).toBeLessThan(1000);
    });
});

describe('checkUnansweredMessages', () => {
    const now = new Date('2026-04-15T12:00:00Z');

    it('returns only unanswered messages older than 4 hours', () => {
        const messages = [
            makeMessage({ id: 'new', receivedAt: hoursAgoFrom(now, 1) }),
            makeMessage({ id: 'old', receivedAt: hoursAgoFrom(now, 5) }),
            makeMessage({ id: 'very-old', receivedAt: hoursAgoFrom(now, 8) }),
            makeMessage({
                id: 'answered-old',
                receivedAt: hoursAgoFrom(now, 6),
                status: MessageStatus.ANSWERED,
            }),
        ];

        const overdue = checkUnansweredMessages(messages, now);
        expect(overdue).toHaveLength(2);
        expect(overdue.map((m) => m.id)).toEqual(['old', 'very-old']);
    });

    it('returns empty array when no messages are overdue', () => {
        const messages = [
            makeMessage({ id: 'a', receivedAt: hoursAgoFrom(now, 0.5) }),
            makeMessage({ id: 'b', receivedAt: hoursAgoFrom(now, 3) }),
        ];
        expect(checkUnansweredMessages(messages, now)).toHaveLength(0);
    });

    it('returns empty array for empty input', () => {
        expect(checkUnansweredMessages([], now)).toHaveLength(0);
    });
});

describe('formatMessageDuration', () => {
    it('formats minutes only for < 1 hour', () => {
        expect(formatMessageDuration(45 * 60 * 1000)).toBe('45m');
    });

    it('formats hours and minutes', () => {
        expect(formatMessageDuration(2.25 * 60 * 60 * 1000)).toBe('2h 15m');
    });

    it('formats exact hours', () => {
        expect(formatMessageDuration(6 * 60 * 60 * 1000)).toBe('6h 0m');
    });

    it('formats zero duration', () => {
        expect(formatMessageDuration(0)).toBe('0m');
    });
});

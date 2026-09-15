import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    generateTicketId,
    formatDuration,
    calculateBackoff,
    truncate,
    domainFromEmail,
    isSlaBreached,
} from '../utils.js';
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS } from '../constants.js';

describe('generateTicketId', () => {
    it('returns format TKT-XXXXXXXX with 8-char suffix', () => {
        const id = generateTicketId();
        expect(id).toMatch(/^TKT-[A-HJ-NP-Z2-9]{8}$/);
    });

    it('uses restricted alphabet (no I, O, 0, 1)', () => {
        // Generate many IDs and verify none contain forbidden chars
        for (let i = 0; i < 200; i++) {
            const id = generateTicketId();
            const suffix = id.replace('TKT-', '');
            expect(suffix).not.toMatch(/[IO01]/);
        }
    });

    it('produces unique IDs across 100 calls', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 100; i++) {
            ids.add(generateTicketId());
        }
        expect(ids.size).toBe(100);
    });

    it('does not depend on Math.random (uses a CSPRNG)', () => {
        // Pin Math.random to a constant: a Math.random-based implementation
        // would then emit the same ID every time.
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        try {
            const ids = new Set<string>();
            for (let i = 0; i < 50; i++) {
                ids.add(generateTicketId());
            }
            expect(ids.size).toBeGreaterThan(1);
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('produces unique IDs across 2000 calls', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 2000; i++) {
            ids.add(generateTicketId());
        }
        // 32^8 keyspace: collisions at 2000 draws are ~1 in a million;
        // a failure here almost certainly means broken randomness.
        expect(ids.size).toBe(2000);
    });

    it('covers the full alphabet over many draws', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 2000; i++) {
            for (const ch of generateTicketId().replace('TKT-', '')) {
                seen.add(ch);
            }
        }
        expect(seen.size).toBe(32);
    });
});

describe('formatDuration', () => {
    it('returns "less than a minute" for 0', () => {
        expect(formatDuration(0)).toBe('less than a minute');
    });

    it('returns "less than a minute" for 0.5', () => {
        expect(formatDuration(0.5)).toBe('less than a minute');
    });

    it('returns "1m" for 1', () => {
        expect(formatDuration(1)).toBe('1m');
    });

    it('returns "1h" for 60', () => {
        expect(formatDuration(60)).toBe('1h');
    });

    it('returns "1h 30m" for 90', () => {
        expect(formatDuration(90)).toBe('1h 30m');
    });

    it('returns "1d" for 1440', () => {
        expect(formatDuration(1440)).toBe('1d');
    });

    it('returns "less than a minute" for negative values', () => {
        expect(formatDuration(-5)).toBe('less than a minute');
    });
});

describe('calculateBackoff', () => {
    it('grows exponentially with attempt number', () => {
        // With jitter, backoff at attempt N should be around BASE * 2^N
        // Fix random to remove jitter for predictable testing
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const b0 = calculateBackoff(0);
        const b1 = calculateBackoff(1);
        const b2 = calculateBackoff(2);

        expect(b0).toBe(BACKOFF_BASE_MS); // 1000 * 2^0 + 0
        expect(b1).toBe(BACKOFF_BASE_MS * 2); // 1000 * 2^1 + 0
        expect(b2).toBe(BACKOFF_BASE_MS * 4); // 1000 * 2^2 + 0
        vi.restoreAllMocks();
    });

    it('adds jitter within [0, BACKOFF_BASE_MS)', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const result = calculateBackoff(0);
        // exponential = 1000, jitter = 0.5 * 1000 = 500
        expect(result).toBe(BACKOFF_BASE_MS + 0.5 * BACKOFF_BASE_MS);
        vi.restoreAllMocks();
    });

    it('respects BACKOFF_MAX_MS cap', () => {
        // Very high attempt should be capped
        const result = calculateBackoff(100);
        expect(result).toBeLessThanOrEqual(BACKOFF_MAX_MS);
    });
});

describe('truncate', () => {
    it('returns original string if within maxLength', () => {
        expect(truncate('hello', 10)).toBe('hello');
    });

    it('returns original string at exact boundary', () => {
        expect(truncate('hello', 5)).toBe('hello');
    });

    it('truncates with ellipsis when exceeding maxLength', () => {
        expect(truncate('hello world', 8)).toBe('hello...');
    });

    it('handles maxLength <= 3 by slicing without ellipsis', () => {
        expect(truncate('hello', 2)).toBe('he');
        expect(truncate('hello', 1)).toBe('h');
        expect(truncate('hello', 3)).toBe('hel');
    });

    it('returns empty string for empty input', () => {
        expect(truncate('', 10)).toBe('');
    });
});

describe('domainFromEmail', () => {
    it('extracts domain from a normal email', () => {
        expect(domainFromEmail('user@example.com')).toBe('example.com');
    });

    it('returns empty string when no @ sign', () => {
        expect(domainFromEmail('not-an-email')).toBe('');
    });

    it('returns the part after the last @ with multiple @ signs', () => {
        const result = domainFromEmail('user@middle@domain.com');
        expect(result).toBe('domain.com');
    });

    it('returns empty string for empty input', () => {
        expect(domainFromEmail('')).toBe('');
    });
});

describe('isSlaBreached', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns true when elapsed time exceeds target', () => {
        // Created 120 minutes ago, target is 60 minutes
        const createdAt = new Date(Date.now() - 120 * 60 * 1000);
        expect(isSlaBreached(createdAt, 60)).toBe(true);
    });

    it('returns false when elapsed time is within target', () => {
        // Created 30 minutes ago, target is 60 minutes
        const createdAt = new Date(Date.now() - 30 * 60 * 1000);
        expect(isSlaBreached(createdAt, 60)).toBe(false);
    });

    it('returns false exactly at the boundary (not strictly greater)', () => {
        // Use a fixed Date.now to test exact boundary
        const now = 1700000000000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const targetMinutes = 60;
        const createdAt = new Date(now - targetMinutes * 60 * 1000);
        // elapsed === target, function uses > not >=
        expect(isSlaBreached(createdAt, targetMinutes)).toBe(false);
    });
});

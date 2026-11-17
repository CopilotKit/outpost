import { describe, it, expect } from 'vitest';
import nextConfig from '../../next.config';

describe('next.config headers', () => {
    it('sets Referrer-Policy: no-referrer on /reset-password, after the global entry so it wins', async () => {
        const entries = await nextConfig.headers!();
        const globalIndex = entries.findIndex((e) => e.source === '/(.*)');
        const resetIndex = entries.findIndex((e) => e.source === '/reset-password');

        expect(resetIndex).toBeGreaterThan(globalIndex);
        expect(entries[resetIndex].headers).toContainEqual({
            key: 'Referrer-Policy',
            value: 'no-referrer',
        });
        expect(entries[globalIndex].headers).toContainEqual({
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
        });
        expect(entries[resetIndex].headers.some((h) => h.key === 'Cache-Control')).toBe(false);
    });
});

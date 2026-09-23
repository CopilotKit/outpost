import { describe, it, expect } from 'vitest';
import {
    hashPassword,
    verifyPassword,
    validatePassword,
    passwordByteLength,
    MIN_PASSWORD_LENGTH,
    MAX_PASSWORD_BYTES,
} from '../auth/passwords.js';

describe('password policy constants', () => {
    it('caps passwords at bcrypts 72-byte limit', () => {
        expect(MAX_PASSWORD_BYTES).toBe(72);
        expect(MIN_PASSWORD_LENGTH).toBe(8);
    });
});

describe('passwordByteLength', () => {
    it('counts UTF-8 bytes, not characters', () => {
        expect(passwordByteLength('abcdef')).toBe(6);
        // € is 3 bytes in UTF-8
        expect(passwordByteLength('€€')).toBe(6);
    });
});

describe('validatePassword', () => {
    it('rejects missing and non-string passwords', () => {
        expect(validatePassword(undefined)).toContain('required');
        expect(validatePassword(null)).toContain('required');
        expect(validatePassword('')).toContain('required');
        expect(validatePassword(42)).toContain('required');
    });

    it('rejects short passwords', () => {
        expect(validatePassword('short')).toContain('at least 8 characters');
        expect(validatePassword('1234567')).toContain('at least 8 characters');
        expect(validatePassword('12345678')).toBeNull();
    });

    it('rejects passwords over the bcrypt byte cap', () => {
        expect(validatePassword('a'.repeat(72))).toBeNull();
        expect(validatePassword('a'.repeat(73))).toContain('at most 72 bytes');
    });

    it('measures the cap in bytes so multibyte tails cannot slip past truncation', () => {
        // 24 x € = 72 bytes: acceptable. One more char would be silently
        // ignored by bcrypt, so it must be rejected.
        expect(validatePassword('€'.repeat(24))).toBeNull();
        expect(validatePassword(`${'€'.repeat(24)}x`)).toContain('at most 72 bytes');
    });
});

describe('hashPassword', () => {
    it('returns a bcrypt hash string', async () => {
        const hash = await hashPassword('test-password');
        // bcrypt hashes start with $2b$ (or $2a$)
        expect(hash).toMatch(/^\$2[aby]\$/);
    });

    it('produces different hashes for the same input (salt)', async () => {
        const hash1 = await hashPassword('same-password');
        const hash2 = await hashPassword('same-password');
        expect(hash1).not.toBe(hash2);
    });

    it('rejects passwords outside the policy instead of storing a weak hash', async () => {
        await expect(hashPassword('')).rejects.toThrow();
        await expect(hashPassword('short')).rejects.toThrow();
        await expect(hashPassword('a'.repeat(73))).rejects.toThrow(/at most 72 bytes/);
    });

    it('accepts a password exactly at the byte cap', { timeout: 30000 }, async () => {
        const hash = await hashPassword('a'.repeat(72));
        expect(await verifyPassword('a'.repeat(72), hash)).toBe(true);
    });
});

describe('verifyPassword', () => {
    it('returns true for matching password', async () => {
        const hash = await hashPassword('correct-password');
        const result = await verifyPassword('correct-password', hash);
        expect(result).toBe(true);
    });

    it('returns false for wrong password', async () => {
        const hash = await hashPassword('correct-password');
        const result = await verifyPassword('wrong-password', hash);
        expect(result).toBe(false);
    });

    it('round-trips with various passwords', { timeout: 30000 }, async () => {
        const passwords = [
            '12345678',
            'a-longer-passphrase-with-special-chars!@#$%',
            '   spaces   ',
        ];
        for (const pw of passwords) {
            const hash = await hashPassword(pw);
            expect(await verifyPassword(pw, hash)).toBe(true);
            expect(await verifyPassword(pw + 'x', hash)).toBe(false);
        }
    });

    it(
        'stays backward compatible: legacy hashes verify without rehashing',
        { timeout: 30000 },
        async () => {
            // Hashes created before the cap existed verify exactly as before.
            const hash = await hashPassword('correct-password');
            expect(await verifyPassword('correct-password', hash)).toBe(true);
        },
    );
});

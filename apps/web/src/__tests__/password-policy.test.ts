import { describe, it, expect } from 'vitest';
import { validateNewPassword } from '@/lib/password-policy';

describe('validateNewPassword', () => {
    it('accepts 8 to 72 bytes when both fields match', () => {
        expect(validateNewPassword('abcdefgh', 'abcdefgh')).toEqual([]);
        expect(validateNewPassword('a'.repeat(72), 'a'.repeat(72))).toEqual([]);
    });

    it('rejects missing, short, and over-72-byte passwords', () => {
        expect(validateNewPassword(undefined, undefined)).toEqual(['Password is required.']);
        expect(validateNewPassword('short', 'short')).toEqual([
            'Password must be at least 8 characters.',
        ]);
        expect(validateNewPassword('a'.repeat(73), 'a'.repeat(73))).toEqual([
            'Password must be 72 bytes or fewer.',
        ]);
    });

    it('counts UTF-8 bytes, not characters', () => {
        const p = 'é'.repeat(37); // 37 characters, 74 bytes
        expect(validateNewPassword(p, p)).toEqual(['Password must be 72 bytes or fewer.']);
    });

    it('reports a mismatch', () => {
        expect(validateNewPassword('abcdefgh', 'abcdefgX')).toEqual(['Passwords do not match.']);
    });

    it('uses caller labels', () => {
        expect(
            validateNewPassword('short', 'other', {
                noun: 'New password',
                mismatch: 'New passwords do not match.',
            }),
        ).toEqual(['New password must be at least 8 characters.', 'New passwords do not match.']);
    });
});

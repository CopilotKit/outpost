import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

export const MIN_PASSWORD_LENGTH = 8;
/**
 * Maximum password size in UTF-8 bytes.
 *
 * bcrypt only processes the first 72 bytes of its input and silently ignores
 * the rest — without this cap, `correct-horse-...<90 chars>` and its 72-byte
 * prefix would hash (and verify) identically, so the extra characters would
 * be security theater. 72 bytes still fits a strong multi-word passphrase.
 */
export const MAX_PASSWORD_BYTES = 72;

/** UTF-8 byte length without Node's Buffer (works in browsers and edge runtimes). */
export function passwordByteLength(password: string): number {
    return new TextEncoder().encode(password).length;
}

/**
 * Check a candidate password against the policy. Returns an error message,
 * or null when the password is acceptable.
 */
export function validatePassword(password: unknown): string | null {
    if (typeof password !== 'string' || password.length === 0) {
        return 'Password is required.';
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (passwordByteLength(password) > MAX_PASSWORD_BYTES) {
        return (
            `Password must be at most ${MAX_PASSWORD_BYTES} bytes; ` +
            'bcrypt ignores anything beyond that, so longer passwords would be weaker than they look.'
        );
    }
    return null;
}

/**
 * Hash a plaintext password using bcrypt.
 * Rejects passwords outside the policy so no caller can accidentally store a
 * truncated-equivalent hash.
 */
export async function hashPassword(plain: string): Promise<string> {
    const policyError = validatePassword(plain);
    if (policyError) {
        throw new Error(policyError);
    }
    return bcrypt.hash(plain, SALT_ROUNDS);
}

/**
 * Verify a plaintext password against a bcrypt hash.
 */
export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
    return bcrypt.compare(plain, hashed);
}

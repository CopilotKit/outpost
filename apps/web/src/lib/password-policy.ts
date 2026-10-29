export const MIN_PASSWORD_LENGTH = 8;
/** bcrypt silently ignores everything after 72 bytes, so longer input is rejected. */
export const MAX_PASSWORD_BYTES = 72;

export interface PasswordLabels {
    noun: string;
    mismatch: string;
}

const DEFAULT_LABELS: PasswordLabels = { noun: 'Password', mismatch: 'Passwords do not match.' };

/**
 * Validate a new password and its confirmation. Returns user-facing messages, in the
 * `{ errors: string[] }` shape the invite-accept, profile, and reset routes return.
 */
export function validateNewPassword(
    password: unknown,
    confirm: unknown,
    labels: PasswordLabels = DEFAULT_LABELS,
): string[] {
    const errors: string[] = [];
    if (!password || typeof password !== 'string') {
        errors.push(`${labels.noun} is required.`);
    } else if (password.length < MIN_PASSWORD_LENGTH) {
        errors.push(`${labels.noun} must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    } else if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
        errors.push(`${labels.noun} must be ${MAX_PASSWORD_BYTES} bytes or fewer.`);
    }
    if (password !== confirm) {
        errors.push(labels.mismatch);
    }
    return errors;
}

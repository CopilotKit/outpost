import { NextResponse, after } from 'next/server';
import { hashPassword } from '@copilotkit/outpost/shared';
import { hit } from '@/lib/rate-limit';
import { clientIp } from '@/lib/client-ip';
import { validateNewPassword } from '@/lib/password-policy';
import {
    consumePasswordReset,
    isWellFormedResetToken,
    sendPasswordChangedEmail,
} from '@/lib/password-reset';
import {
    INVALID_RESET_LINK,
    guardPublicResetRoute,
    readJsonObject,
    resetServerError,
    tooManyRequests,
} from '@/lib/password-reset-route';

/**
 * Set a new password from a reset link. Revokes every session (consume bumps
 * sessionVersion). Does not sign the user in: the page sends them to /login?reset=1.
 */
export async function POST(request: Request) {
    const blocked = guardPublicResetRoute(request);
    if (blocked) return blocked;
    const body = await readJsonObject(request);

    try {
        // Limit and validate before bcrypt, so junk cannot buy ~250 ms of CPU each.
        const limit = await hit(`pwreset:confirm:ip:${clientIp(request)}`, 20, 15 * 60);
        if (!limit.allowed) {
            console.warn('[PASSWORD_RESET] rate-limited scope=confirm');
            return tooManyRequests();
        }

        const errors = validateNewPassword(body.password, body.confirmPassword);
        if (errors.length > 0) {
            return NextResponse.json({ errors }, { status: 400 });
        }
        if (!isWellFormedResetToken(body.token)) {
            return NextResponse.json({ error: INVALID_RESET_LINK }, { status: 410 });
        }

        // Hashed before the transaction so bcrypt never holds row locks.
        const passwordHash = await hashPassword(body.password as string);
        const result = await consumePasswordReset(body.token, passwordHash);
        if (!result.ok) {
            return NextResponse.json({ error: INVALID_RESET_LINK }, { status: 410 });
        }

        console.info(`[PASSWORD_RESET] consumed memberId=${result.member.id}`);
        after(() => sendPasswordChangedEmail(result.member));
        return NextResponse.json({ ok: true });
    } catch (err) {
        return resetServerError('confirm', err);
    }
}

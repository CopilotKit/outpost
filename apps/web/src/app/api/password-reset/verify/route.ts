import { NextResponse } from 'next/server';
import { hit } from '@/lib/rate-limit';
import { clientIp } from '@/lib/client-ip';
import { isResetTokenValid } from '@/lib/password-reset';
import {
    INVALID_RESET_LINK,
    guardPublicResetRoute,
    readJsonObject,
    resetServerError,
    tooManyRequests,
} from '@/lib/password-reset-route';

/**
 * Lets the reset page show the expired state before the user types a password.
 * The token arrives in the POST body (the page reads it from the URL fragment) and
 * is never logged. Shares the confirm IP limit, since both routes test tokens.
 */
export async function POST(request: Request) {
    const blocked = guardPublicResetRoute(request);
    if (blocked) return blocked;
    const body = await readJsonObject(request);

    try {
        const limit = await hit(`pwreset:confirm:ip:${clientIp(request)}`, 20, 15 * 60);
        if (!limit.allowed) {
            console.warn('[PASSWORD_RESET] rate-limited scope=confirm');
            return tooManyRequests();
        }
        if (!(await isResetTokenValid(body.token))) {
            return NextResponse.json({ error: INVALID_RESET_LINK }, { status: 410 });
        }
        return NextResponse.json({ ok: true });
    } catch (err) {
        return resetServerError('verify', err);
    }
}

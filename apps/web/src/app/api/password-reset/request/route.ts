import { createHash } from 'crypto';
import { NextResponse, after } from 'next/server';
import { prisma } from '@copilotkit/outpost/db';
import { hit } from '@/lib/rate-limit';
import { clientIp } from '@/lib/client-ip';
import { issuePasswordReset } from '@/lib/password-reset';
import {
    guardPublicResetRoute,
    readJsonObject,
    resetServerError,
    tooManyRequests,
} from '@/lib/password-reset-route';

// Same shape check as the invite route.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Always answers 200 { ok: true } for a valid email shape, whether or not the
 * account exists. The lookup and send run in after(), so the response time does not
 * reveal whether an email was sent.
 */
export async function POST(request: Request) {
    const blocked = guardPublicResetRoute(request);
    if (blocked) return blocked;

    const body = await readJsonObject(request);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !EMAIL_SHAPE.test(email)) {
        return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }

    try {
        const byIp = await hit(`pwreset:req:ip:${clientIp(request)}`, 10, 15 * 60);
        if (!byIp.allowed) {
            console.warn('[PASSWORD_RESET] rate-limited scope=ip');
            return tooManyRequests();
        }

        // Hashed so raw addresses are not stored; counted for unknown emails too, so
        // the limit itself does not reveal whether an account exists.
        const emailKey = createHash('sha256').update(email).digest('hex');
        const byEmail = await hit(`pwreset:req:email:${emailKey}`, 3, 60 * 60);
        if (!byEmail.allowed) {
            console.warn('[PASSWORD_RESET] rate-limited scope=email');
        } else {
            after(async () => {
                try {
                    const member = await prisma.teamMember.findUnique({
                        where: { email },
                        select: {
                            id: true,
                            email: true,
                            status: true,
                            passwordHash: true,
                            sessionVersion: true,
                        },
                    });
                    if (member && member.status === 'ACTIVE' && member.passwordHash) {
                        await issuePasswordReset(member, { requestedById: null });
                    }
                } catch (err) {
                    console.error(
                        `[PASSWORD_RESET] request failed error=${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            });
        }
    } catch (err) {
        return resetServerError('request', err);
    }

    return NextResponse.json({ ok: true });
}

import { NextResponse } from 'next/server';
import { prisma } from '@copilotkit/outpost/db';
import { requireAdmin } from '@/lib/require-admin';
import { authProvider } from '@/lib/auth-provider';
import { hit } from '@/lib/rate-limit';
import { issuePasswordReset } from '@/lib/password-reset';
import { resetServerError } from '@/lib/password-reset-route';

/**
 * Admin sends a member the same reset link the member could request themselves
 * (spec §10). The response never contains the token or URL: unlike invite resend,
 * an admin holding the link could set the member's password and sign in as them.
 * Sending revokes nothing; sessions end only when the link is used.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { error, session } = await requireAdmin();
    if (error) return error;
    if (authProvider() !== 'credentials') {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { id } = await params;
    const adminId = (session.user as Record<string, unknown>).memberId as string;
    if (id === adminId) {
        return NextResponse.json(
            { error: 'Use Forgot password or your profile to change your own password.' },
            { status: 400 },
        );
    }

    const member = await prisma.teamMember.findUnique({
        where: { id },
        select: { id: true, email: true, status: true, passwordHash: true, sessionVersion: true },
    });
    if (!member) {
        return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }
    if (member.status !== 'ACTIVE' || !member.passwordHash) {
        return NextResponse.json(
            {
                error: 'This member has no password to reset. Only active members who sign in with a password can get a reset link.',
            },
            { status: 409 },
        );
    }

    // Per target member, so several admins together cannot flood one inbox; separate
    // from the self-service per-email limit, so a locked-out member can still get one.
    // Counted before the issue, so a failed send still uses a slot: the 429 copy must
    // not claim a link was sent. A limiter error is a 500, never a send (fail closed).
    let limit: { allowed: boolean };
    try {
        limit = await hit(`pwreset:admin:member:${id}`, 3, 60 * 60);
    } catch (err) {
        return resetServerError('admin', err);
    }
    if (!limit.allowed) {
        console.warn('[PASSWORD_RESET] rate-limited scope=admin');
        return NextResponse.json(
            { error: 'Too many reset attempts for this member. Try again later.' },
            { status: 429 },
        );
    }

    // Synchronous: no timing side channel to hide from an admin. The service logs
    // "admin-issued memberId=… by=…" (spec §9).
    const { emailSent } = await issuePasswordReset(member, { requestedById: adminId });
    return NextResponse.json({ ok: true, emailSent });
}

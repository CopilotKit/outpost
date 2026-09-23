import { randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@copilotkit/outpost/db';
import { requireAdmin } from '@/lib/require-admin';
import { sendEmail } from '@copilotkit/outpost/shared/server';

/**
 * Minimum time between two invite (re)sends to the same member.
 * Without this, a compromised admin session (or a retry loop) can emit an
 * unbounded stream of invite emails.
 */
const INVITE_RESEND_COOLDOWN_MS = 60_000;

export async function POST(request: Request) {
    const { error } = await requireAdmin();
    if (error) return error;

    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const { memberId } = body as { memberId?: string };

    if (!memberId) {
        return NextResponse.json({ error: 'memberId is required' }, { status: 400 });
    }

    try {
        const member = await prisma.teamMember.findUnique({
            where: { id: memberId },
        });

        if (!member || member.status !== 'INVITED') {
            return NextResponse.json({ error: 'No pending invitation found for this member' }, { status: 404 });
        }

        // Throttle resends per member: the latest token's creation time is
        // the last (re)send. InviteToken.memberId is unique, so at most one
        // row exists per member.
        const latestToken = await prisma.inviteToken.findUnique({
            where: { memberId },
            select: { createdAt: true },
        });
        if (latestToken) {
            const elapsedMs = Date.now() - latestToken.createdAt.getTime();
            if (elapsedMs < INVITE_RESEND_COOLDOWN_MS) {
                const retryAfterSec = Math.ceil((INVITE_RESEND_COOLDOWN_MS - elapsedMs) / 1000);
                return NextResponse.json(
                    { error: `Invite was sent recently. Try again in ${retryAfterSec} seconds.` },
                    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
                );
            }
        }

        const token = randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

        // Delete old token and create new one
        await prisma.inviteToken.deleteMany({ where: { memberId } });
        await prisma.inviteToken.create({
            data: {
                memberId,
                token,
                expiresAt,
            },
        });

        const inviteUrl = `${process.env.NEXTAUTH_URL ?? 'http://localhost:3000'}/invite/accept?token=${token}`;
        const responseData = { success: true, inviteUrl };

        // Send invite email via template system
        const org = await prisma.organization.findFirst();
        try {
            const emailResult = await sendEmail({
                to: member.email,
                template: 'invite',
                context: {
                    org: {
                        name: org?.name || 'Outpost',
                        email: org?.email || 'noreply@outpost.dev',
                    },
                    member: {
                        name: member.name || member.email.split('@')[0],
                        email: member.email,
                        invitedBy: 'A team member',
                        role: member.role,
                    },
                    invite: {
                        url: inviteUrl,
                        expiresIn: '1 hour',
                    },
                },
            });

            if (!emailResult.success) {
                console.warn(`[INVITE] Failed to resend invite email to ${member.email}: ${emailResult.error}`);
                return NextResponse.json({ ...responseData, emailSent: false });
            }
        } catch (emailError) {
            console.warn('Failed to send invite email:', emailError);
            // Still return success (invite was created) but flag email failure
            return NextResponse.json({ ...responseData, emailSent: false });
        }

        return NextResponse.json(responseData);
    } catch (err) {
        console.error('[POST /api/team/invite/resend] Error:', err);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

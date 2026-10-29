import { NextResponse, type NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { encode, getToken } from 'next-auth/jwt';
import { authOptions } from '@/lib/auth';
import { prisma } from '@copilotkit/outpost/db';
import { hashPassword, verifyPassword } from '@copilotkit/outpost/shared';
import { authProvider, providerHasSessionCheck } from '@/lib/auth-provider';
import { validateNewPassword } from '@/lib/password-policy';
import { DEFAULT_SESSION_MAX_AGE, sessionCookie, sessionCookieWrites } from '@/lib/session-cookie';

type ProfileRow = {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    role: string;
};

function profileBody(m: ProfileRow) {
    return { id: m.id, name: m.name, email: m.email, avatarUrl: m.avatarUrl, role: m.role };
}

function sessionEnded() {
    return NextResponse.json({ error: 'Your session has ended. Sign in again.' }, { status: 401 });
}

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = session.user as Record<string, unknown>;
    const member = await prisma.teamMember.findUnique({
        where: { id: user.memberId as string },
    });

    if (!member) {
        return NextResponse.json({ error: 'Member not found.' }, { status: 404 });
    }

    return NextResponse.json({
        id: member.id,
        name: member.name,
        email: member.email,
        avatarUrl: member.avatarUrl,
        role: member.role,
    });
}

export async function PUT(request: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = session.user as Record<string, unknown>;
    const memberId = user.memberId as string;

    const member = await prisma.teamMember.findUnique({
        where: { id: memberId },
    });

    if (!member) {
        return NextResponse.json({ error: 'Member not found.' }, { status: 404 });
    }

    const body = await request.json();
    const { name, avatarUrl, currentPassword, newPassword, confirmNewPassword } = body;

    const errors: string[] = [];

    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
        errors.push('Name must be a non-empty string.');
    }

    // Password change validation
    if (newPassword !== undefined || currentPassword !== undefined) {
        if (!currentPassword) {
            errors.push('Current password is required to change password.');
        }
        errors.push(
            ...validateNewPassword(newPassword, confirmNewPassword, {
                noun: 'New password',
                mismatch: 'New passwords do not match.',
            }),
        );

        // Verify current password
        if (currentPassword && member.passwordHash) {
            const valid = await verifyPassword(currentPassword, member.passwordHash);
            if (!valid) {
                errors.push('Current password is incorrect.');
            }
        } else if (currentPassword && !member.passwordHash) {
            errors.push('Cannot change password for OAuth-linked accounts.');
        }
    }

    if (errors.length > 0) {
        return NextResponse.json({ errors }, { status: 400 });
    }

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name.trim();
    if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl?.trim() || null;

    if (!newPassword) {
        const updated = await prisma.teamMember.update({
            where: { id: memberId },
            data: updateData,
        });
        return NextResponse.json(profileBody(updated));
    }

    // Hashed before any database write.
    updateData.passwordHash = await hashPassword(newPassword);

    if (!providerHasSessionCheck(authProvider())) {
        // GitHub mode has no session check, so there is nothing to re-issue (spec §6).
        const updated = await prisma.teamMember.update({
            where: { id: memberId },
            data: { ...updateData, sessionVersion: { increment: 1 } },
        });
        return NextResponse.json(profileBody(updated));
    }

    // Keep THIS session and revoke the member's others (spec §6, decision 4).
    // getServerSession above already accepted this cookie and the current password was
    // verified. getToken is used only to copy the claims for the re-issue, never to
    // authorize. It needs a NextRequest: it reads req.cookies.getAll().
    const secret = process.env.NEXTAUTH_SECRET;
    const cookie = sessionCookie();
    const token = secret ? await getToken({ req: request, secret, cookieName: cookie.name }) : null;
    if (!secret || !token || token.memberId !== memberId) {
        return sessionEnded();
    }
    const oldSv = typeof token.sv === 'number' ? token.sv : 0;

    // Compare-and-set from this token's own version to exactly +1. If anything else
    // (a reset, a disable, another password change) moved the version since the
    // session check, this matches nothing and the session is NOT revived.
    const { count } = await prisma.teamMember.updateMany({
        where: { id: memberId, status: 'ACTIVE', sessionVersion: oldSv },
        data: { ...updateData, sessionVersion: { increment: 1 } },
    });
    if (count !== 1) {
        return sessionEnded();
    }

    const maxAge = authOptions.session?.maxAge ?? DEFAULT_SESSION_MAX_AGE;
    // encode() sets fresh iat/exp/jti: the same rolling refresh NextAuth does per read.
    const reissued = await encode({ token: { ...token, sv: oldSv + 1 }, secret, maxAge });
    const updated = await prisma.teamMember.findUnique({ where: { id: memberId } });

    const response = NextResponse.json(profileBody(updated ?? member));
    // Same chunking and cleanup as NextAuth: a token over one cookie is split into
    // name.0, name.1, …, and stale request chunks (or the bare cookie) are expired.
    const requestCookieNames = request.cookies.getAll().map((c) => c.name);
    for (const w of sessionCookieWrites(cookie, reissued, maxAge, requestCookieNames)) {
        response.cookies.set(w.name, w.value, w.options);
    }
    return response;
}

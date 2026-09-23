import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { prisma } from '@copilotkit/outpost/db';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_BYTES, passwordByteLength } from '@copilotkit/outpost/shared';

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

export async function PUT(request: Request) {
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
        if (!newPassword || typeof newPassword !== 'string') {
            errors.push('New password is required.');
        } else if (newPassword.length < MIN_PASSWORD_LENGTH) {
            errors.push(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        } else if (passwordByteLength(newPassword) > MAX_PASSWORD_BYTES) {
            errors.push(
                `New password must be at most ${MAX_PASSWORD_BYTES} bytes; bcrypt ignores anything beyond that.`,
            );
        }
        if (newPassword !== confirmNewPassword) {
            errors.push('New passwords do not match.');
        }

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
    if (newPassword) updateData.passwordHash = await hashPassword(newPassword);

    const updated = await prisma.teamMember.update({
        where: { id: memberId },
        data: updateData,
    });

    return NextResponse.json({
        id: updated.id,
        name: updated.name,
        email: updated.email,
        avatarUrl: updated.avatarUrl,
        role: updated.role,
    });
}

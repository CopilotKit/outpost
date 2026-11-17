import { NextResponse } from 'next/server';
import { prisma } from '@copilotkit/outpost/db';
import { hashPassword } from '@copilotkit/outpost/shared';
import { validateNewPassword } from '@/lib/password-policy';

// The member was disabled (or otherwise left INVITED) after the invite was sent.
const NO_LONGER_VALID = () =>
    NextResponse.json({ error: 'This invite is no longer valid' }, { status: 410 });

export async function GET(request: Request) {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token) {
        return NextResponse.json({ error: 'Token is required' }, { status: 400 });
    }

    const inviteToken = await prisma.inviteToken.findUnique({
        where: { token },
        include: { member: true },
    });

    if (!inviteToken) {
        return NextResponse.json({ error: 'Invalid invite token' }, { status: 404 });
    }

    if (inviteToken.usedAt) {
        return NextResponse.json({ error: 'This invite has already been used' }, { status: 410 });
    }

    if (inviteToken.expiresAt < new Date()) {
        return NextResponse.json({ error: 'This invite has expired' }, { status: 410 });
    }

    if (inviteToken.member.status !== 'INVITED') {
        return NO_LONGER_VALID();
    }

    // Fetch the org name for display
    const org = await prisma.organization.findFirst();

    return NextResponse.json({
        email: inviteToken.member.email,
        orgName: org?.name ?? 'Outpost',
        orgLogo: org?.logoUrl ?? null,
    });
}

export async function POST(request: Request) {
    const body = await request.json();
    const { token, name, password, confirmPassword } = body;

    if (!token) {
        return NextResponse.json({ error: 'Token is required' }, { status: 400 });
    }

    const errors: string[] = [];

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
        errors.push('Name is required.');
    }

    errors.push(...validateNewPassword(password, confirmPassword));

    if (errors.length > 0) {
        return NextResponse.json({ errors }, { status: 400 });
    }

    const inviteToken = await prisma.inviteToken.findUnique({
        where: { token },
        include: { member: true },
    });

    if (!inviteToken) {
        return NextResponse.json({ error: 'Invalid invite token' }, { status: 404 });
    }

    if (inviteToken.usedAt) {
        return NextResponse.json({ error: 'This invite has already been used' }, { status: 410 });
    }

    if (inviteToken.expiresAt < new Date()) {
        return NextResponse.json({ error: 'This invite has expired' }, { status: 410 });
    }

    if (inviteToken.member.status !== 'INVITED') {
        return NO_LONGER_VALID();
    }

    const passwordHash = await hashPassword(password);

    // Activate only a member that is still INVITED. The status condition is part of
    // the UPDATE, so a disable that lands after the check above still wins.
    const member = await prisma.$transaction(async (tx) => {
        const { count } = await tx.teamMember.updateMany({
            where: { id: inviteToken.memberId, status: 'INVITED' },
            data: {
                name: name.trim(),
                passwordHash,
                status: 'ACTIVE',
                joinedAt: new Date(),
            },
        });
        if (count === 0) return null;
        await tx.inviteToken.update({
            where: { id: inviteToken.id },
            data: { usedAt: new Date() },
        });
        return tx.teamMember.findUniqueOrThrow({ where: { id: inviteToken.memberId } });
    });

    if (!member) {
        return NO_LONGER_VALID();
    }

    return NextResponse.json({
        id: member.id,
        name: member.name,
        email: member.email,
        role: member.role,
    });
}

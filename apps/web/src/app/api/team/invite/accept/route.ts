import { NextResponse } from 'next/server';
import { prisma } from '@copilotkit/outpost/db';
import { hashPassword, validatePassword } from '@copilotkit/outpost/shared';

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

    if (!password || typeof password !== 'string') {
        errors.push('Password is required.');
    } else {
        const policyError = validatePassword(password);
        if (policyError) errors.push(policyError);
    }

    if (password !== confirmPassword) {
        errors.push('Passwords do not match.');
    }

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

    const passwordHash = await hashPassword(password);

    // Update member and mark token used in a transaction
    const [member] = await prisma.$transaction([
        prisma.teamMember.update({
            where: { id: inviteToken.memberId },
            data: {
                name: name.trim(),
                passwordHash,
                status: 'ACTIVE',
                joinedAt: new Date(),
            },
        }),
        prisma.inviteToken.update({
            where: { id: inviteToken.id },
            data: { usedAt: new Date() },
        }),
    ]);

    return NextResponse.json({
        id: member.id,
        name: member.name,
        email: member.email,
        role: member.role,
    });
}

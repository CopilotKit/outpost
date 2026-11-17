import { NextResponse } from 'next/server';
import { prisma } from '@copilotkit/outpost/db';
import { requireAdmin } from '@/lib/require-admin';

export async function GET() {
    const { error } = await requireAdmin();
    if (error) return error;

    const members = await prisma.teamMember.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
            id: true,
            name: true,
            email: true,
            role: true,
            status: true,
            avatarUrl: true,
            invitedAt: true,
            joinedAt: true,
            createdAt: true,
            passwordHash: true,
        },
    });

    // The hash is selected only to compute hasPassword; it never leaves the server.
    return NextResponse.json(
        members.map(({ passwordHash, ...member }) => ({
            ...member,
            hasPassword: passwordHash !== null,
        })),
    );
}

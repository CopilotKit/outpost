import { NextResponse } from 'next/server';
import { prisma } from '@copilotkit/outpost/db';
import { requireAdmin } from '@/lib/require-admin';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { error, session } = await requireAdmin();
    if (error) return error;

    const { id } = await params;
    const body = await request.json();
    const { role, status } = body;

    // Prevent self-demotion
    const memberId = (session!.user as Record<string, unknown>).memberId;
    if (id === memberId && role && role !== 'ADMIN') {
        return NextResponse.json({ error: 'Cannot change your own role' }, { status: 400 });
    }
    // Prevent self-disable: it bumps sessionVersion and blocks sign-in, so the caller
    // would lock themselves out (and a sole admin would lock out the instance).
    if (id === memberId && status && status !== 'ACTIVE') {
        return NextResponse.json({ error: 'Cannot change your own status' }, { status: 400 });
    }

    const data: Record<string, unknown> = {};
    if (role && ['ADMIN', 'MEMBER'].includes(role)) {
        data.role = role;
    }
    if (status && ['ACTIVE', 'DISABLED'].includes(status)) {
        data.status = status;
        // The status check alone revokes a disabled member's sessions; the bump makes
        // sure re-enabling them does not revive those old sessions (spec §4).
        if (status === 'DISABLED') {
            data.sessionVersion = { increment: 1 };
        }
    }

    if (Object.keys(data).length === 0) {
        return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const select = { id: true, name: true, email: true, role: true, status: true } as const;

    if (data.status !== 'ACTIVE') {
        const member = await prisma.teamMember.update({ where: { id }, data, select });
        return NextResponse.json(member);
    }

    // Enabling a member who never joined (no password and no joinedAt) restores INVITED
    // instead. ACTIVE would strand them: invite accept takes only INVITED members, and
    // a reset link needs a password. As INVITED, the outstanding invite works again and
    // the admin can resend it. Both fields are tested because neither alone means
    // "never joined": create-admin and the seed write a password without joinedAt, and
    // OIDC members have joinedAt without a password. Either one means they can sign
    // in, so they go back to ACTIVE. The predicate is in each WHERE, so an accept that
    // lands between the two writes is never undone.
    const neverJoined = await prisma.teamMember.updateMany({
        where: { id, joinedAt: null, passwordHash: null },
        data: { ...data, status: 'INVITED' },
    });
    const joined = await prisma.teamMember.updateMany({
        where: { id, OR: [{ joinedAt: { not: null } }, { passwordHash: { not: null } }] },
        data,
    });
    if (neverJoined.count + joined.count === 0) {
        return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    const member = await prisma.teamMember.findUnique({ where: { id }, select });
    return NextResponse.json(member);
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { error, session } = await requireAdmin();
    if (error) return error;

    const { id } = await params;

    // Prevent self-removal
    const memberId = (session!.user as Record<string, unknown>).memberId;
    if (id === memberId) {
        return NextResponse.json({ error: 'Cannot remove yourself' }, { status: 400 });
    }

    await prisma.teamMember.delete({ where: { id } });

    return NextResponse.json({ success: true });
}

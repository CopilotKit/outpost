import { NextResponse } from 'next/server';
import { prisma } from '@copilotkit/outpost/db';
import { requireAdmin } from '@/lib/require-admin';

export async function POST(request: Request) {
    const { error, session } = await requireAdmin();
    if (error) return error;

    const body = await request.json();
    const { confirmation, reseed } = body as { confirmation: string; reseed?: boolean };

    if (confirmation !== 'RESET') {
        return NextResponse.json(
            { error: 'Invalid confirmation. You must send confirmation: "RESET".' },
            { status: 400 },
        );
    }

    const memberId = (session!.user as Record<string, unknown>).memberId as string;

    // Save the Organization row and the requesting admin's TeamMember row
    const org = await prisma.organization.findFirst();
    const adminMember = await prisma.teamMember.findUnique({ where: { id: memberId } });

    if (!adminMember) {
        return NextResponse.json(
            { error: 'Could not find your team member record.' },
            { status: 500 },
        );
    }

    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`
            TRUNCATE TABLE
                "DiscussionMessage", "Discussion", "Message", "Note",
                "TicketExternalLink", "Ticket", "InviteToken", "ExternalIdentity",
                "User", "Account", "Job", "Agent", "Broadcast",
                "DocArticle", "DocCategory", "SlaConfig", "OnboardingMember",
                "SyncEvent", "SystemConfig", "TemplateOverride"
            CASCADE;
        `);

        await tx.$executeRawUnsafe(`TRUNCATE TABLE "TeamMember" CASCADE;`);

        await tx.teamMember.create({
            data: {
                id: adminMember.id,
                name: adminMember.name,
                email: adminMember.email,
                role: adminMember.role,
                status: adminMember.status,
                avatarUrl: adminMember.avatarUrl,
                passwordHash: adminMember.passwordHash,
                joinedAt: adminMember.joinedAt,
                // Without this the rebuilt row falls back to the default 0, and an
                // admin whose version was ever bumped is signed out by their own reset.
                sessionVersion: adminMember.sessionVersion,
            },
        });
    });

    // Handle optional re-seed
    let reseeded = false;
    if (reseed) {
        // The seed script uses a top-level async IIFE with its own PrismaClient,
        // so it cannot be cleanly imported. Manual re-seed is required.
        reseeded = false;
    }

    return NextResponse.json({
        success: true,
        reseeded,
        ...(!reseeded && reseed
            ? { note: 'Manual re-seed required. Run: npx prisma db seed' }
            : {}),
    });
}

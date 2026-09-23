import { NextResponse } from 'next/server';
import { prisma } from '@copilotkit/outpost/db';
import { hashPassword, validatePassword } from '@copilotkit/outpost/shared';

export async function POST(request: Request) {
    // Guard: only allow setup when no team members exist
    const existingCount = await prisma.teamMember.count();
    if (existingCount > 0) {
        return NextResponse.json(
            { error: 'Setup already completed. An admin account already exists.' },
            { status: 403 },
        );
    }

    const body = await request.json();
    const {
        orgName, orgEmail, orgLogoUrl, orgTagline,
        name, email, password, confirmPassword,
    } = body;

    // Validate required fields
    const errors: string[] = [];

    // Organization validation
    if (!orgName || typeof orgName !== 'string' || orgName.trim().length === 0) {
        errors.push('Organization name is required.');
    }

    if (!orgEmail || typeof orgEmail !== 'string') {
        errors.push('Organization email is required.');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(orgEmail)) {
        errors.push('Organization email must be a valid email address.');
    }

    // Admin validation
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
        errors.push('Name is required.');
    }

    if (!email || typeof email !== 'string') {
        errors.push('Email is required.');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push('Email must be a valid email address.');
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

    const passwordHash = await hashPassword(password);

    // Create organization and admin in a transaction
    const result = await prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({
            data: {
                name: orgName.trim(),
                email: orgEmail.trim().toLowerCase(),
                logoUrl: orgLogoUrl?.trim() || null,
                tagline: orgTagline?.trim() || null,
            },
        });

        const member = await tx.teamMember.create({
            data: {
                name: name.trim(),
                email: email.trim().toLowerCase(),
                passwordHash,
                role: 'ADMIN',
                status: 'ACTIVE',
                joinedAt: new Date(),
            },
        });

        return { org, member };
    });

    return NextResponse.json({
        organization: {
            id: result.org.id,
            name: result.org.name,
            email: result.org.email,
        },
        admin: {
            id: result.member.id,
            name: result.member.name,
            email: result.member.email,
            role: result.member.role,
        },
    });
}

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { prisma } from '@copilotkit/outpost/db';
import { listTemplateSlugs, loadFromFilesystem } from '@copilotkit/outpost/shared/server';
import type { TemplateListEntry } from '@copilotkit/outpost/shared/server';

/**
 * GET /api/templates
 *
 * List all templates, merging filesystem defaults with stored overrides. An
 * overridden entry reports the override's subject and edit metadata, so the list
 * shows what is actually in effect rather than what is on disk.
 */
export async function GET(_request: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const slugs = listTemplateSlugs();

    // One query rather than one per slug.
    const overrides = await prisma.templateOverride.findMany({
        where: { slug: { in: slugs } },
    });
    const bySlug = new Map(overrides.map((o) => [o.slug, o]));

    const entries: TemplateListEntry[] = slugs.map((slug) => {
        const loaded = loadFromFilesystem(slug);
        const override = bySlug.get(slug);

        return {
            slug,
            name: loaded?.meta.name || slug,
            subject: override?.subject ?? loaded?.meta.subject ?? '',
            isOverride: Boolean(override),
            updatedAt: override?.updatedAt ? override.updatedAt.toISOString() : null,
            editedBy: override?.editedBy ?? null,
        };
    });

    return NextResponse.json(entries);
}

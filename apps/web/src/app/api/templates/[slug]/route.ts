import { NextRequest, NextResponse } from 'next/server';
import { requireSession, requireAdmin } from '@/lib/require-admin';
import { prisma } from '@copilotkit/outpost/db';
import { isKnownTemplateSlug, loadTemplate } from '@copilotkit/outpost/shared/server';

/** Bounds on stored template content. The subject becomes an email header downstream. */
const SUBJECT_MAX = 500;
const BODY_MAX = 100_000;

/**
 * Look up a stored override for a slug.
 *
 * Passed into `loadTemplate` so the shared loader stays free of a Prisma
 * dependency — it takes the lookup as an argument.
 */
async function findOverride(slug: string): Promise<{ subject: string; body: string } | null> {
    const override = await prisma.templateOverride.findUnique({ where: { slug } });
    if (!override) return null;
    return { subject: override.subject, body: override.body };
}

/**
 * GET /api/templates/[slug]
 *
 * Get a single template's content: the stored override if one exists, otherwise
 * the filesystem default.
 */
export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ slug: string }> },
) {
    const { error } = await requireSession();
    if (error) return error;

    const { slug } = await params;

    // Checked before the loader sees it. `loadFromFilesystem` builds
    // `join(dir, slug + '.md')` with no validation and Next decodes
    // percent-encoding in a dynamic segment, so `../docs/deployment` reached the
    // loader as a traversal and this handler returned the file's `subject` and
    // `body` in its JSON. Verified against the real function before fixing.
    if (!isKnownTemplateSlug(slug)) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    const loaded = await loadTemplate(slug, findOverride);

    if (!loaded) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    return NextResponse.json({
        slug: loaded.slug,
        name: loaded.meta.name,
        subject: loaded.meta.subject,
        from: loaded.meta.from,
        body: loaded.body,
        isOverride: loaded.isOverride,
    });
}

/**
 * PUT /api/templates/[slug]
 *
 * Save a template override (ADMIN only).
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
    const { error, session } = await requireAdmin();
    if (error) return error;

    const { slug } = await params;

    let payload: unknown;
    try {
        payload = await request.json();
    } catch {
        return NextResponse.json({ error: 'Request body is not valid JSON' }, { status: 400 });
    }

    const { subject, body: templateBody } = (payload ?? {}) as Record<string, unknown>;

    // Type-checked, not truthiness-checked: `{ subject: {}, body: [1] }` used to reach
    // the upsert and surface as a 500 where a 400 belongs.
    if (
        typeof subject !== 'string' ||
        typeof templateBody !== 'string' ||
        !subject.trim() ||
        !templateBody.trim()
    ) {
        return NextResponse.json(
            { error: 'subject and body are required strings' },
            { status: 400 },
        );
    }

    // Both columns are unbounded in the schema, and the subject becomes an email header
    // downstream, so the bound belongs here.
    if (subject.length > SUBJECT_MAX || templateBody.length > BODY_MAX) {
        return NextResponse.json(
            { error: `subject must be under ${SUBJECT_MAX} characters and body under ${BODY_MAX}` },
            { status: 400 },
        );
    }

    // An override only means anything layered over a real template: the loader takes
    // its name and `from` from the filesystem entry, and the editor lists filesystem
    // slugs. Without this check an arbitrary slug would create a row nothing reads.
    //
    // Membership rather than an existence probe. `if (!loadFromFilesystem(slug))`
    // read as a guard and was the traversal: the read SUCCEEDS for
    // `../docs/deployment`, so the check approved the request it appeared to
    // reject. A traversal path is never a member of the slug list however it is
    // spelled, and a slug that passes here is already known to exist.
    if (!isKnownTemplateSlug(slug)) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    // Falls back to the member id: the session callback always sets one, so an absent
    // email should not cost us the audit trail on a security-relevant screen.
    const user = session.user as Record<string, unknown> | undefined;
    const editedBy =
        (typeof user?.email === 'string' ? user.email : null) ??
        (typeof user?.memberId === 'string' ? user.memberId : null);

    const saved = await prisma.templateOverride.upsert({
        where: { slug },
        create: { slug, subject, body: templateBody, editedBy },
        update: { subject, body: templateBody, editedBy },
    });

    return NextResponse.json({
        slug,
        subject: saved.subject,
        body: saved.body,
        isOverride: true,
        editedBy: saved.editedBy ?? editedBy,
        updatedAt: saved.updatedAt,
    });
}

/**
 * DELETE /api/templates/[slug]
 *
 * Reset a template to its filesystem default by removing the stored override
 * (ADMIN only). Uses deleteMany so resetting an already-default template is a
 * no-op rather than a 404 from Prisma.
 */
export async function DELETE(
    _request: NextRequest,
    { params }: { params: Promise<{ slug: string }> },
) {
    const { error } = await requireAdmin();
    if (error) return error;

    const { slug } = await params;

    // Not a traversal risk on its own — `deleteMany` on an unknown slug matches
    // nothing. Checked anyway so all four handlers answer the same way for the
    // same input; GET returning 404 while DELETE reports `reset: true` for the
    // same slug is the kind of disagreement that gets read as one of them being
    // wrong.
    if (!isKnownTemplateSlug(slug)) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    const { count } = await prisma.templateOverride.deleteMany({ where: { slug } });

    return NextResponse.json({ slug, reset: true, hadOverride: count > 0 });
}

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { prisma } from '@copilotkit/outpost/db';
import { isKnownTemplateSlug, renderTemplate } from '@copilotkit/outpost/shared/server';
import type { TemplateContext } from '@copilotkit/outpost/shared/server';

/** Sample data used for template previews. */
const SAMPLE_CONTEXT: TemplateContext = {
    org: { name: 'Acme Corp', email: 'support@acme.com' },
    member: {
        name: 'Jane Smith',
        email: 'jane@acme.com',
        invitedBy: 'John Admin',
        role: 'Engineer',
    },
    customer: { name: 'Alex Customer', email: 'alex@example.com' },
    invite: { url: 'https://app.outpost.dev/invite/sample-token', expiresIn: '7 days' },
    app: { url: 'https://app.outpost.dev' },
    ticket: {
        displayId: 'TKT-0042',
        title: 'Cannot connect to API endpoint',
        url: 'https://app.outpost.dev/tickets/tkt-0042',
        priority: 'HIGH',
        assignee: 'Jane Smith',
        resolution:
            'The API endpoint was updated to v2. Updated the SDK configuration to point to the new URL.',
    },
    sla: { target: '4 hours', elapsed: '6 hours 23 minutes' },
    escalation: {
        by: 'System',
        from: 'Jane Smith',
        to: 'John Admin',
        reason: 'SLA breach and no response in 6 hours',
    },
    digest: {
        date: new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        }),
        openTickets: '12',
        resolvedToday: '5',
        breachedSla: '1',
        assignedToYou: '3',
        awaitingResponse: '2',
    },
};

/**
 * POST /api/templates/[slug]/preview
 *
 * Render a template with sample data and return the HTML.
 *
 * Accepts an optional `draft` ({ subject, body }) so the editor can preview
 * UNSAVED edits. Without it the preview rendered whatever was stored, which meant
 * an author validated content they were not about to save. Also accepts an optional
 * `context` to override the sample data.
 */
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ slug: string }> },
) {
    const session = await getServerSession(authOptions);
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { slug } = await params;

    // A template must exist on disk for an override or a draft to layer onto, and PUT
    // refuses a slug that has none. Checked here too so preview and save agree —
    // otherwise a renamed or deleted template previews happily and then fails to save.
    //
    // Membership rather than an existence probe, for the reason PUT gives: a read
    // of `../docs/deployment` succeeds, so `if (!loadFromFilesystem(slug))`
    // approved the traversal it looked like it rejected.
    if (!isKnownTemplateSlug(slug)) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    // Read once, then parsed here rather than by `request.json()`.
    //
    // No body at all is fine — it means "preview what is stored". Unparseable JSON
    // is not: silently rendering the stored template would show the author content
    // they did not ask for, which is the bug this route was fixed for.
    //
    // Two reasons for this shape. "Empty" now comes from the body itself instead of
    // `content-length`, because a bodiless POST can arrive with no such header at
    // all — chunked, or a server-side `new Request(url, { method: 'POST' })` — and
    // keying on `!== '0'` sent those to a 400 rather than previewing, the opposite
    // of the intent. And a request body can only be read once: calling
    // `request.json()` first consumes the stream, so a later `text()` returns empty
    // and an unparseable body would have read as "no body" and previewed the stored
    // template — reintroducing the bug this route exists to fix.
    const raw = await request.text().catch(() => '');

    let parsed: unknown = null;
    if (raw.trim() !== '') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return NextResponse.json({ error: 'Request body is not valid JSON' }, { status: 400 });
        }
    }

    const body = (parsed ?? {}) as Record<string, unknown>;

    let context = SAMPLE_CONTEXT;
    if (body.context && typeof body.context === 'object') {
        context = { ...SAMPLE_CONTEXT, ...(body.context as object) };
    }

    // A draft that is present but unusable is a client bug, not a request to preview
    // the stored copy. Note '' is a valid body — an author may be clearing it.
    const draft = body.draft as { subject?: unknown; body?: unknown } | undefined;
    if (draft !== undefined) {
        if (
            draft === null ||
            typeof draft !== 'object' ||
            typeof draft.subject !== 'string' ||
            typeof draft.body !== 'string'
        ) {
            return NextResponse.json(
                { error: 'draft requires both subject and body as strings' },
                { status: 400 },
            );
        }
    }

    const useDraft = draft !== undefined;

    // The loader takes its content from this lookup when it returns non-null, so an
    // unsaved draft is supplied the same way a stored override would be — the draft
    // wins over the stored row, which is the whole point of previewing edits.
    const lookup = useDraft
        ? async () => ({ subject: draft!.subject as string, body: draft!.body as string })
        : async (s: string) => {
              const override = await prisma.templateOverride.findUnique({ where: { slug: s } });
              return override ? { subject: override.subject, body: override.body } : null;
          };

    const result = await renderTemplate(slug, context, lookup);
    if (!result) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    return NextResponse.json({
        subject: result.subject,
        html: result.html,
        text: result.text,
        markdown: result.markdown,
    });
}

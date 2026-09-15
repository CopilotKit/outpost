import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * Template routes: persistence and preview fidelity (outpost#226).
 *
 * Before this suite, all three write paths were stubs. `PUT` validated its input
 * and returned a success body without touching the database, while the UI reported
 * "Template saved successfully" — so an author's edit was silently discarded. `GET`
 * read only the filesystem, so even a real write would not have been visible. And
 * preview rendered the STORED template rather than the unsaved draft, which is what
 * made the XSS sink on that screen matter: the preview is the surface an author
 * trusts to show them what they wrote.
 *
 * The loader and renderer are used for real here (repo-root `templates/` resolves
 * from `apps/web`), so these assertions are about rendered output rather than about
 * a mock of the thing under test. Only the session and the database are mocked.
 */

const mockGetServerSession = vi.fn();

// require-admin imports from 'next-auth'; the list and preview routes import from
// 'next-auth/next'. Both need mocking or half the routes see no session.
// Wrapped rather than passed directly: the route modules are imported by the hoisted
// import statements below, which run before this file's consts initialise, so the
// factory must not read the variable until call time.
vi.mock('next-auth', () => ({
    getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));
vi.mock('next-auth/next', () => ({
    getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

const mockOverrideFindUnique = vi.fn();
const mockOverrideFindMany = vi.fn();
const mockOverrideUpsert = vi.fn();
const mockOverrideDeleteMany = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        templateOverride: {
            findUnique: (...args: unknown[]) => mockOverrideFindUnique(...args),
            findMany: (...args: unknown[]) => mockOverrideFindMany(...args),
            upsert: (...args: unknown[]) => mockOverrideUpsert(...args),
            deleteMany: (...args: unknown[]) => mockOverrideDeleteMany(...args),
        },
    },
}));

import {
    GET as getTemplate,
    PUT as putTemplate,
    DELETE as deleteTemplate,
} from '@/app/api/templates/[slug]/route';
import { GET as listTemplates } from '@/app/api/templates/route';
import { POST as previewTemplate } from '@/app/api/templates/[slug]/preview/route';

const ADMIN_SESSION = { user: { id: 'u-admin', email: 'admin@copilotkit.ai', role: 'ADMIN' } };
const MEMBER_SESSION = { user: { id: 'u-member', email: 'member@copilotkit.ai', role: 'MEMBER' } };

/** A slug that exists in the repo-root templates/ directory. */
const REAL_SLUG = 'welcome';

// Both `text` and `json` are stubbed because the two routes read the body
// differently: PUT uses `json()`, and preview reads `text()` once and parses it
// itself — a request body can only be read once, so calling `json()` first would
// consume the stream and leave an unparseable body looking empty.
function jsonRequest(body: unknown): NextRequest {
    return {
        text: async () => JSON.stringify(body),
        json: async () => body,
    } as unknown as NextRequest;
}

/** A request with no body at all, which preview treats as "render what is stored". */
function bareRequest(): NextRequest {
    return {
        text: async () => '',
        json: async () => ({}),
    } as unknown as NextRequest;
}

function routeParams(slug: string) {
    return { params: Promise.resolve({ slug }) };
}

describe('template persistence and preview (outpost#226)', () => {
    beforeEach(() => {
        mockGetServerSession.mockReset();
        mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
        mockOverrideFindUnique.mockReset();
        mockOverrideFindUnique.mockResolvedValue(null);
        mockOverrideFindMany.mockReset();
        mockOverrideFindMany.mockResolvedValue([]);
        mockOverrideUpsert.mockReset();
        // Returns a realistic row, including the non-nullable updatedAt. A mock that
        // omitted it previously made a dead `?? new Date()` fallback in the route look
        // exercised — a test artifact shaping production code.
        mockOverrideUpsert.mockImplementation(
            async (args: { create: Record<string, unknown> }) => ({
                id: 'ovr-1',
                editedBy: null,
                createdAt: new Date('2026-08-20T00:00:00Z'),
                updatedAt: new Date('2026-08-20T00:00:00Z'),
                ...args.create,
            }),
        );
        mockOverrideDeleteMany.mockReset();
        mockOverrideDeleteMany.mockResolvedValue({ count: 1 });
    });

    describe('PUT actually persists', () => {
        it('writes the override to the database', async () => {
            const res = await putTemplate(
                jsonRequest({ subject: 'Saved subject', body: 'Saved body' }),
                routeParams(REAL_SLUG),
            );

            expect(res.status).toBe(200);
            expect(mockOverrideUpsert).toHaveBeenCalledTimes(1);

            const args = mockOverrideUpsert.mock.calls[0][0];
            expect(args.where).toEqual({ slug: REAL_SLUG });
            expect(args.create).toMatchObject({
                slug: REAL_SLUG,
                subject: 'Saved subject',
                body: 'Saved body',
            });
            expect(args.update).toMatchObject({ subject: 'Saved subject', body: 'Saved body' });
        });

        it('records who edited it', async () => {
            await putTemplate(jsonRequest({ subject: 's', body: 'b' }), routeParams(REAL_SLUG));

            const args = mockOverrideUpsert.mock.calls[0][0];
            expect(args.create.editedBy).toBe('admin@copilotkit.ai');
            expect(args.update.editedBy).toBe('admin@copilotkit.ai');
        });

        it('refuses a slug that has no template, rather than creating a phantom override', async () => {
            const res = await putTemplate(
                jsonRequest({ subject: 's', body: 'b' }),
                routeParams('no-such-template'),
            );

            expect(res.status).toBe(404);
            expect(mockOverrideUpsert).not.toHaveBeenCalled();
        });

        it('still rejects a non-admin', async () => {
            mockGetServerSession.mockResolvedValue(MEMBER_SESSION);

            const res = await putTemplate(
                jsonRequest({ subject: 's', body: 'b' }),
                routeParams(REAL_SLUG),
            );

            expect(res.status).toBe(403);
            expect(mockOverrideUpsert).not.toHaveBeenCalled();
        });
    });

    describe('the write paths stay gated', () => {
        // These were stubs before this change and are now real, so the gate on each is
        // the assertion most worth pinning: swapping requireAdmin for requireSession
        // would otherwise let any member wipe every override with nothing failing.
        it('refuses DELETE for a non-admin', async () => {
            mockGetServerSession.mockResolvedValue(MEMBER_SESSION);

            const res = await deleteTemplate(bareRequest(), routeParams(REAL_SLUG));

            expect(res.status).toBe(403);
            expect(mockOverrideDeleteMany).not.toHaveBeenCalled();
        });

        it('refuses preview for an unauthenticated request', async () => {
            mockGetServerSession.mockResolvedValue(null);

            const res = await previewTemplate(bareRequest(), routeParams(REAL_SLUG));

            expect(res.status).toBe(401);
        });

        it('refuses the list for an unauthenticated request', async () => {
            mockGetServerSession.mockResolvedValue(null);

            const res = await listTemplates(bareRequest());

            expect(res.status).toBe(401);
        });
    });

    describe('PUT validates types and bounds, not just truthiness', () => {
        it('rejects non-string fields with a 400 rather than failing in the database', async () => {
            const res = await putTemplate(
                jsonRequest({ subject: {}, body: [1] }),
                routeParams(REAL_SLUG),
            );

            expect(res.status).toBe(400);
            expect(mockOverrideUpsert).not.toHaveBeenCalled();
        });

        it('rejects whitespace-only content', async () => {
            const res = await putTemplate(
                jsonRequest({ subject: '   ', body: '  \n ' }),
                routeParams(REAL_SLUG),
            );

            expect(res.status).toBe(400);
            expect(mockOverrideUpsert).not.toHaveBeenCalled();
        });

        it('rejects an oversized body', async () => {
            const res = await putTemplate(
                jsonRequest({ subject: 's', body: 'x'.repeat(100_001) }),
                routeParams(REAL_SLUG),
            );

            expect(res.status).toBe(400);
            expect(mockOverrideUpsert).not.toHaveBeenCalled();
        });

        it('rejects a body that is not valid JSON', async () => {
            const badRequest = {
                json: async () => {
                    throw new SyntaxError('bad');
                },
            } as unknown as NextRequest;

            const res = await putTemplate(badRequest, routeParams(REAL_SLUG));

            expect(res.status).toBe(400);
        });
    });

    describe('GET reads back what was saved', () => {
        it('returns the stored override instead of the filesystem default', async () => {
            mockOverrideFindUnique.mockResolvedValue({
                slug: REAL_SLUG,
                subject: 'Overridden subject',
                body: 'Overridden body',
                editedBy: 'admin@copilotkit.ai',
                updatedAt: new Date('2026-08-20T00:00:00Z'),
            });

            const res = await getTemplate(bareRequest(), routeParams(REAL_SLUG));
            const data = await res.json();

            expect(data.subject).toBe('Overridden subject');
            expect(data.body).toBe('Overridden body');
            expect(data.isOverride).toBe(true);
        });

        it('falls back to the filesystem default when there is no override', async () => {
            const res = await getTemplate(bareRequest(), routeParams(REAL_SLUG));
            const data = await res.json();

            expect(data.isOverride).toBe(false);
            expect(data.body.length).toBeGreaterThan(0);
            expect(data.body).not.toBe('Overridden body');
        });
    });

    // The slug reached `join(dir, slug + '.md')` unvalidated, and Next decodes
    // percent-encoding in a dynamic segment before a handler runs — so
    // `../docs/deployment` arrived as a traversal, the loader read the file, and GET
    // returned its `subject` and `body` in the JSON response. Confirmed against the
    // real loader: `../README`, `../CLAUDE`, `../docs/deployment` and
    // `invite/../../README` all returned file contents.
    //
    // The existence checks did not close it — they WERE it. A guard shaped like
    // `if (!loadFromFilesystem(slug))` succeeds for every path above, so it approved
    // the request it appeared to reject.
    describe('a slug outside the template set is refused everywhere', () => {
        const TRAVERSALS = ['../README', '../CLAUDE', '../docs/deployment', 'invite/../../README'];

        it.each(TRAVERSALS)('GET refuses %s rather than returning the file', async (slug) => {
            const res = await getTemplate(bareRequest(), routeParams(slug));

            expect(res.status).toBe(404);
            const data = await res.json();
            // The proof is the absence of file content, not just the status: a 200
            // carrying the deployment guide is the failure being pinned.
            expect(data.body).toBeUndefined();
            expect(data.subject).toBeUndefined();
        });

        it.each(TRAVERSALS)('PUT refuses %s', async (slug) => {
            const res = await putTemplate(
                jsonRequest({ subject: 'x', body: 'y' }),
                routeParams(slug),
            );

            expect(res.status).toBe(404);
            expect(mockOverrideUpsert).not.toHaveBeenCalled();
        });

        it.each(TRAVERSALS)('preview refuses %s', async (slug) => {
            const res = await previewTemplate(bareRequest(), routeParams(slug));

            expect(res.status).toBe(404);
        });

        // Harmless on its own — deleteMany matches nothing — but all four handlers
        // should answer the same way for the same input.
        it.each(TRAVERSALS)('DELETE refuses %s', async (slug) => {
            const res = await deleteTemplate(bareRequest(), routeParams(slug));

            expect(res.status).toBe(404);
            expect(mockOverrideDeleteMany).not.toHaveBeenCalled();
        });

        it('still serves the real slugs', async () => {
            const res = await getTemplate(bareRequest(), routeParams(REAL_SLUG));

            expect(res.status).toBe(200);
            expect((await res.json()).body.length).toBeGreaterThan(0);
        });
    });

    describe('DELETE actually removes the override', () => {
        it('deletes the stored row', async () => {
            const res = await deleteTemplate(bareRequest(), routeParams(REAL_SLUG));

            expect(res.status).toBe(200);
            expect(mockOverrideDeleteMany).toHaveBeenCalledWith({ where: { slug: REAL_SLUG } });
        });
    });

    describe('the list reflects override state', () => {
        it('marks an overridden template and carries its edit metadata', async () => {
            mockOverrideFindMany.mockResolvedValue([
                {
                    slug: REAL_SLUG,
                    subject: 'Overridden subject',
                    body: 'b',
                    editedBy: 'admin@copilotkit.ai',
                    updatedAt: new Date('2026-08-20T00:00:00Z'),
                },
            ]);

            const res = await listTemplates(bareRequest());
            const entries = await res.json();
            const entry = entries.find((e: { slug: string }) => e.slug === REAL_SLUG);

            expect(entry.isOverride).toBe(true);
            expect(entry.subject).toBe('Overridden subject');
            expect(entry.editedBy).toBe('admin@copilotkit.ai');
            expect(entry.updatedAt).not.toBeNull();
        });

        it('leaves a non-overridden template marked as default', async () => {
            const res = await listTemplates(bareRequest());
            const entries = await res.json();
            const entry = entries.find((e: { slug: string }) => e.slug === REAL_SLUG);

            expect(entry.isOverride).toBe(false);
            expect(entry.editedBy).toBeNull();
        });
    });

    describe('a draft that cannot be honoured is refused, not silently swapped', () => {
        // Falling back to the stored template on a bad draft would re-introduce the
        // exact bug this route is being fixed for: the author sees content they are
        // not editing, and gets a 200 saying all is well.
        it('rejects a draft missing its subject rather than rendering the stored template', async () => {
            mockOverrideFindUnique.mockResolvedValue({
                slug: REAL_SLUG,
                subject: 'Stored subject',
                body: 'STORED-BODY-MARKER',
                editedBy: null,
                updatedAt: new Date(),
            });

            const res = await previewTemplate(
                jsonRequest({ draft: { body: 'only a body' } }),
                routeParams(REAL_SLUG),
            );

            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.html).toBeUndefined();
        });

        it('rejects a draft whose fields are the wrong type', async () => {
            const res = await previewTemplate(
                jsonRequest({ draft: { subject: { evil: true }, body: ['x'] } }),
                routeParams(REAL_SLUG),
            );

            expect(res.status).toBe(400);
        });

        it('rejects a body that is not valid JSON', async () => {
            const badRequest = {
                // Unparseable text rather than a throwing `json()`: the route parses
                // the text itself, so that is the shape a real bad body arrives in.
                text: async () => '{ not json',
                json: async () => {
                    throw new SyntaxError('Unexpected token');
                },
                headers: { get: () => null },
            } as unknown as NextRequest;

            const res = await previewTemplate(badRequest, routeParams(REAL_SLUG));

            expect(res.status).toBe(400);
        });

        it('still allows an intentionally empty body, which is a valid draft', async () => {
            const res = await previewTemplate(
                jsonRequest({ draft: { subject: 'Subject only', body: '' } }),
                routeParams(REAL_SLUG),
            );

            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.subject).toBe('Subject only');
        });

        it('refuses a slug with no template even when a draft is supplied', async () => {
            const res = await previewTemplate(
                jsonRequest({ draft: { subject: 's', body: 'b' } }),
                routeParams('no-such-template'),
            );

            expect(res.status).toBe(404);
        });
    });

    describe('preview renders the draft, not the stored template', () => {
        it('renders unsaved body content sent with the request', async () => {
            const res = await previewTemplate(
                jsonRequest({ draft: { subject: 'Draft subject', body: 'UNSAVED-BODY-MARKER' } }),
                routeParams(REAL_SLUG),
            );
            const data = await res.json();

            expect(data.html).toContain('UNSAVED-BODY-MARKER');
            expect(data.subject).toBe('Draft subject');
        });

        it('does not fall back to the stored override when a draft is supplied', async () => {
            mockOverrideFindUnique.mockResolvedValue({
                slug: REAL_SLUG,
                subject: 'Stored subject',
                body: 'STORED-BODY-MARKER',
                editedBy: null,
                updatedAt: new Date(),
            });

            const res = await previewTemplate(
                jsonRequest({ draft: { subject: 'Draft subject', body: 'UNSAVED-BODY-MARKER' } }),
                routeParams(REAL_SLUG),
            );
            const data = await res.json();

            expect(data.html).toContain('UNSAVED-BODY-MARKER');
            expect(data.html).not.toContain('STORED-BODY-MARKER');
        });

        it('still renders the stored template when no draft is supplied', async () => {
            mockOverrideFindUnique.mockResolvedValue({
                slug: REAL_SLUG,
                subject: 'Stored subject',
                body: 'STORED-BODY-MARKER',
                editedBy: null,
                updatedAt: new Date(),
            });

            const res = await previewTemplate(bareRequest(), routeParams(REAL_SLUG));
            const data = await res.json();

            expect(data.html).toContain('STORED-BODY-MARKER');
            expect(data.subject).toBe('Stored subject');
        });

        it('interpolates variables in the draft rather than emitting them raw', async () => {
            const res = await previewTemplate(
                jsonRequest({
                    draft: { subject: 'Hi {{member.name}}', body: 'Hello {{member.name}}' },
                }),
                routeParams(REAL_SLUG),
            );
            const data = await res.json();

            expect(data.subject).toBe('Hi Jane Smith');
            expect(data.html).toContain('Jane Smith');
            expect(data.html).not.toContain('{{member.name}}');
        });
    });
});

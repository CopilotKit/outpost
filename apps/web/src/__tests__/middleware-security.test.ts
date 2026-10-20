import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Security-ordering tests for the middleware.
 *
 * Deliberately separate from `middleware.test.ts`, which mocks `@/lib/csrf` with
 * `requiresCsrfValidation: () => false`. That mock makes CSRF enforcement
 * unobservable, so no test in that file can fail when CSRF is skipped. These tests
 * use the REAL csrf module so the assertions are about the middleware's actual
 * behaviour rather than about a stub.
 *
 * Covers the ordering guarantee: a convenience early-return (static assets / any path
 * containing a dot) sat above both the auth check and the CSRF check, so
 * `PATCH /api/accounts/x.json` reached the handler with neither applied.
 */

const mockGetToken = vi.fn();
vi.mock('next-auth/jwt', () => ({
    getToken: (...args: unknown[]) => mockGetToken(...args),
}));

// A fuller next/server mock than middleware.test.ts uses: the real csrf module calls
// NextResponse.json for its 403s, so that has to exist and be identifiable.
const mockNext = vi.fn();
const mockRedirect = vi.fn();
const mockJson = vi.fn();

vi.mock('next/server', () => ({
    NextResponse: {
        next: () => mockNext(),
        redirect: (...args: unknown[]) => mockRedirect(...args),
        json: (body: unknown, init?: { status?: number }) => mockJson(body, init),
    },
}));

// NOTE: @/lib/csrf is intentionally NOT mocked.
import { middleware } from '@/middleware';

interface MockRequestOptions {
    method?: string;
    csrfCookie?: string;
    csrfHeader?: string;
}

function createMockRequest(pathname: string, options: MockRequestOptions = {}): unknown {
    const { method = 'GET', csrfCookie, csrfHeader } = options;
    return {
        method,
        nextUrl: { pathname },
        url: `http://localhost:3000${pathname}`,
        cookies: {
            get: (name: string) =>
                name === 'csrf' && csrfCookie !== undefined ? { value: csrfCookie } : undefined,
        },
        headers: {
            get: (name: string) =>
                name.toLowerCase() === 'x-csrf-token' && csrfHeader !== undefined
                    ? csrfHeader
                    : null,
        },
    };
}

/** A response object carrying a cookie jar, so setCsrfCookie has something to write to. */
function responseStub(type: string) {
    return { type, cookies: { set: vi.fn() } };
}

describe('middleware security ordering', () => {
    beforeEach(() => {
        mockGetToken.mockReset();
        mockNext.mockReset();
        mockNext.mockImplementation(() => responseStub('next'));
        mockRedirect.mockReset();
        mockRedirect.mockImplementation(() => responseStub('redirect'));
        mockJson.mockReset();
        // The rejection is handed to setCsrfCookie on its way out, so a 403 response
        // needs a cookie jar just like a next()/redirect() one does.
        mockJson.mockImplementation((body, init) => ({
            ...responseStub('json'),
            body,
            status: init?.status,
        }));
    });

    describe('a dot in the path must not skip CSRF validation', () => {
        it('rejects a mutating request to a dotted /api/ path that carries no CSRF token', async () => {
            mockGetToken.mockResolvedValue({ sub: '123', memberId: 'm1' });

            const req = createMockRequest('/api/accounts/x.json', { method: 'PATCH' });
            const result = (await middleware(req as never)) as { status?: number };

            expect(mockJson).toHaveBeenCalledWith({ error: 'Missing CSRF token' }, { status: 403 });
            expect(result.status).toBe(403);
        });

        it('rejects a mutating request to a dotted /api/ path whose CSRF token does not match', async () => {
            mockGetToken.mockResolvedValue({ sub: '123', memberId: 'm1' });

            const req = createMockRequest('/api/accounts/x.json', {
                method: 'PATCH',
                csrfCookie: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                csrfHeader: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            });
            const result = (await middleware(req as never)) as { status?: number };

            expect(mockJson).toHaveBeenCalledWith({ error: 'Invalid CSRF token' }, { status: 403 });
            expect(result.status).toBe(403);
        });

        // The extension allowlist alone does not cover this: `.xml` and `.svg` ARE
        // static extensions, so without the isApiRoute gate these paths would take the
        // static bypass and skip both checks. Export-style API routes ending in a real
        // asset extension are the reachable case.
        it.each(['/api/reports/data.xml', '/api/accounts/logo.svg', '/api/export/dump.txt'])(
            'rejects a mutating request to %s, whose extension is otherwise a static one',
            async (pathname) => {
                mockGetToken.mockResolvedValue({ sub: '123', memberId: 'm1' });

                const req = createMockRequest(pathname, { method: 'POST' });
                const result = (await middleware(req as never)) as { status?: number };

                expect(mockJson).toHaveBeenCalledWith(
                    { error: 'Missing CSRF token' },
                    { status: 403 },
                );
                expect(result.status).toBe(403);
            },
        );

        it('allows a mutating request to a dotted /api/ path when the CSRF token matches', async () => {
            mockGetToken.mockResolvedValue({ sub: '123', memberId: 'm1' });
            const token = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

            const req = createMockRequest('/api/accounts/x.json', {
                method: 'PATCH',
                csrfCookie: token,
                csrfHeader: token,
            });
            await middleware(req as never);

            expect(mockJson).not.toHaveBeenCalled();
            expect(mockNext).toHaveBeenCalled();
            // Without this, the test also passes if the static bypass wrongly fires —
            // that path returns next() and never touches json(). This is what makes the
            // assertion mean "went through auth and CSRF and passed".
            expect(mockGetToken).toHaveBeenCalled();
        });
    });

    describe('a dot in the path must not skip authentication', () => {
        it('does not let an unauthenticated request through to a dotted /api/ path', async () => {
            mockGetToken.mockResolvedValue(null);

            const req = createMockRequest('/api/accounts/x.json', { method: 'PATCH' });
            await middleware(req as never);

            expect(mockGetToken).toHaveBeenCalled();
            expect(mockNext).not.toHaveBeenCalled();
        });

        // This diff's whole risk surface is that more traffic now reaches getToken.
        // next-auth catches its own decode failures and returns null, so a bad secret or
        // a tampered JWT already fails closed — but nothing pinned that. If someone later
        // wraps the getToken call in a try/catch, this is what stops it failing open.
        it('fails closed if the auth lookup itself throws', async () => {
            mockGetToken.mockRejectedValue(new Error('no NEXTAUTH_SECRET'));

            const req = createMockRequest('/api/accounts/x.json', { method: 'PATCH' });
            await expect(middleware(req as never)).rejects.toThrow('no NEXTAUTH_SECRET');

            expect(mockNext).not.toHaveBeenCalled();
        });

        it('does not let an unauthenticated request through to a dotted app path', async () => {
            mockGetToken.mockResolvedValue(null);

            const req = createMockRequest('/settings/templates/welcome.email');
            await middleware(req as never);

            expect(mockGetToken).toHaveBeenCalled();
            expect(mockNext).not.toHaveBeenCalled();
        });
    });

    describe('genuine static assets still bypass without an auth lookup', () => {
        it.each(['/_next/static/chunk.js', '/_next/image', '/favicon.ico'])(
            'allows %s',
            async (pathname) => {
                const req = createMockRequest(pathname);
                await middleware(req as never);

                expect(mockNext).toHaveBeenCalled();
                expect(mockGetToken).not.toHaveBeenCalled();
            },
        );

        // The cases above all pass via the `/_next` and `/favicon` prefix arms, so they
        // do NOT exercise STATIC_ASSET_PATH at all — swapping the regex for a
        // never-matching one still leaves them green. These pin the allowlist's allow
        // direction. `/og-image.svg` is load-bearing: layout.tsx serves it as the
        // OpenGraph image, and link scrapers fetch it with no session.
        it.each(['/og-image.svg', '/robots.txt', '/sitemap.xml', '/fonts/inter.woff2'])(
            'allows the allowlisted static path %s without an auth lookup',
            async (pathname) => {
                const req = createMockRequest(pathname);
                await middleware(req as never);

                expect(mockNext).toHaveBeenCalled();
                expect(mockGetToken).not.toHaveBeenCalled();
            },
        );
    });

    describe('exempt API paths keep working', () => {
        it.each(['/api/health', '/api/webhooks/postmark/inbound'])(
            'allows a POST to %s with no CSRF token',
            async (pathname) => {
                const req = createMockRequest(pathname, { method: 'POST' });
                await middleware(req as never);

                expect(mockJson).not.toHaveBeenCalled();
                expect(mockNext).toHaveBeenCalled();
            },
        );
    });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as NextServer from 'next/server';

// Mock next-auth/jwt
const mockGetToken = vi.fn();
vi.mock('next-auth/jwt', () => ({
    getToken: (...args: unknown[]) => mockGetToken(...args),
}));

// Mock next/server
const mockRedirect = vi.fn();
const mockNext = vi.fn().mockReturnValue({ type: 'next' });

// NextResponse is stubbed so each test can see which branch the middleware took.
// NextRequest stays the real class, so tests can build genuine requests with it.
vi.mock('next/server', async (importOriginal) => ({
    ...(await importOriginal<typeof NextServer>()),
    NextResponse: {
        redirect: (...args: unknown[]) => mockRedirect(...args),
        next: () => mockNext(),
    },
}));

// Mock CSRF helpers so they don't touch real request.cookies
vi.mock('@/lib/csrf', () => ({
    requiresCsrfValidation: () => false,
    validateCsrfToken: () => null,
    setCsrfCookie: (_req: unknown, res: unknown) => res,
}));

// Import after mocks
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

function createMockRequest(pathname: string): unknown {
    return {
        nextUrl: {
            pathname,
        },
        url: `http://localhost:3000${pathname}`,
    };
}

describe('Auth middleware', () => {
    beforeEach(() => {
        mockGetToken.mockReset();
        mockRedirect.mockReset();
        mockRedirect.mockReturnValue({ type: 'redirect' });
        mockNext.mockClear();
    });

    it('allows /login without authentication', async () => {
        const req = createMockRequest('/login');
        await middleware(req as never);
        expect(mockNext).toHaveBeenCalled();
        expect(mockRedirect).not.toHaveBeenCalled();
    });

    it('allows /api/auth routes without authentication', async () => {
        const req = createMockRequest('/api/auth/callback/github');
        await middleware(req as never);
        expect(mockNext).toHaveBeenCalled();
        expect(mockRedirect).not.toHaveBeenCalled();
    });

    it('redirects unauthenticated users to /login', async () => {
        mockGetToken.mockResolvedValue(null);
        const req = createMockRequest('/dashboard');
        await middleware(req as never);
        expect(mockRedirect).toHaveBeenCalled();
    });

    it('allows authenticated users through', async () => {
        mockGetToken.mockResolvedValue({ sub: '123', name: 'Test' });
        const req = createMockRequest('/dashboard');
        await middleware(req as never);
        expect(mockNext).toHaveBeenCalled();
    });

    it('allows /setup without authentication', async () => {
        const req = createMockRequest('/setup');
        await middleware(req as never);
        expect(mockNext).toHaveBeenCalled();
        expect(mockRedirect).not.toHaveBeenCalled();
    });

    it('allows /api/setup without authentication', async () => {
        const req = createMockRequest('/api/setup');
        await middleware(req as never);
        expect(mockNext).toHaveBeenCalled();
        expect(mockRedirect).not.toHaveBeenCalled();
    });

    it('allows /api/webhooks without authentication', async () => {
        const req = createMockRequest('/api/webhooks/postmark/inbound');
        await middleware(req as never);
        expect(mockNext).toHaveBeenCalled();
        expect(mockRedirect).not.toHaveBeenCalled();
    });

    it('allows static assets through', async () => {
        const req = createMockRequest('/_next/static/chunk.js');
        await middleware(req as never);
        expect(mockNext).toHaveBeenCalled();
        expect(mockGetToken).not.toHaveBeenCalled();
    });

    describe('password reset public paths (outpost#206)', () => {
        function realRequest(pathname: string, method = 'GET'): NextRequest {
            return new NextRequest(`http://localhost:3000${pathname}`, { method });
        }

        it.each([
            ['GET', '/forgot-password'],
            ['GET', '/reset-password'],
            ['POST', '/api/password-reset/request'],
            ['POST', '/api/password-reset/verify'],
            ['POST', '/api/password-reset/confirm'],
        ])('allows %s %s without authentication', async (method, path) => {
            await middleware(realRequest(path, method));
            expect(mockNext).toHaveBeenCalled();
            expect(mockGetToken).not.toHaveBeenCalled();
            expect(mockRedirect).not.toHaveBeenCalled();
        });

        // Nothing else becomes public. A public entry matches only itself or a path
        // below it, so a sibling that merely shares the prefix ('/loginx',
        // '/reset-password-evil') still needs a session.
        it.each([
            '/api/password-reset-evil',
            '/api/password-reset',
            '/api/passwordreset/request',
            '/reset-password-evil',
            '/forgot-password-evil',
            '/forgot-passwordX',
            '/loginx',
            '/api/authz',
            '/setupx',
            '/api/setup-evil',
            '/api/healthz',
            '/invite/acceptx',
            '/api/team/invite/accepted',
            '/api/webhooksx',
            '/dashboard',
            '/api/team',
            '/settings',
        ])('still redirects unauthenticated %s to /login', async (path) => {
            mockGetToken.mockResolvedValue(null);
            await middleware(realRequest(path));
            expect(mockGetToken).toHaveBeenCalled();
            expect(mockRedirect).toHaveBeenCalledTimes(1);
            const target = mockRedirect.mock.calls[0][0] as URL;
            expect(target.pathname).toBe('/login');
            expect(target.searchParams.get('callbackUrl')).toBe(path);
            expect(mockNext).not.toHaveBeenCalled();
        });
    });

    // Walks the real app/ tree, so a new route is checked without editing this test.
    describe('every app route', () => {
        const appDir = path.resolve(__dirname, '../app');

        // The routes that must work without a session. Dynamic segments are filled in.
        const EXPECTED_PUBLIC = new Set([
            '/login',
            '/setup',
            '/forgot-password',
            '/reset-password',
            '/invite/accept',
            '/api/auth/x',
            '/api/setup',
            '/api/health',
            '/api/team/invite/accept',
            '/api/webhooks/postmark',
            '/api/password-reset/request',
            '/api/password-reset/verify',
            '/api/password-reset/confirm',
        ]);

        function collectRoutes(dir: string): string[] {
            const out: string[] = [];
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    out.push(...collectRoutes(full));
                } else if (/^(page|route)\.tsx?$/.test(entry.name)) {
                    const rel = path.relative(appDir, dir).split(path.sep).filter(Boolean);
                    const segments = rel
                        .filter((s) => !/^\(.*\)$/.test(s))
                        .map((s) => (s.startsWith('[') ? 'x' : s));
                    out.push('/' + segments.join('/'));
                }
            }
            return out;
        }

        const routes = collectRoutes(appDir);

        it('finds every expected public route on disk', () => {
            for (const expected of EXPECTED_PUBLIC) {
                expect(routes).toContain(expected);
            }
        });

        it.each(routes)('%s is public only if expected', async (route) => {
            mockGetToken.mockResolvedValue(null);
            await middleware(new NextRequest(`http://localhost:3000${route}`));
            if (EXPECTED_PUBLIC.has(route)) {
                expect(mockGetToken).not.toHaveBeenCalled();
                expect(mockRedirect).not.toHaveBeenCalled();
                expect(mockNext).toHaveBeenCalled();
            } else {
                expect(mockRedirect).toHaveBeenCalledTimes(1);
            }
        });
    });
});

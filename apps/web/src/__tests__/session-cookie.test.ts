import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@copilotkit/outpost/db', () => ({ prisma: {} }));
vi.mock('@copilotkit/outpost/shared', () => ({ verifyPassword: vi.fn() }));

import type { NextAuthOptions } from 'next-auth';
import { sessionCookie, DEFAULT_SESSION_MAX_AGE } from '@/lib/session-cookie';
import { authOptions } from '@/lib/auth';

// NextAuth's own option resolver (core/init.js). It is not in next-auth's `exports` map, so
// it is loaded by file path from the installed package with Node's require: the real code
// that turns authOptions + the request origin into the cookie names and session maxAge.
interface ResolvedOptions {
    cookies: { sessionToken: { name: string; options: Record<string, unknown> } };
    session: { maxAge: number };
}
type NextAuthInit = (params: {
    authOptions: NextAuthOptions;
    origin: string;
    action: string;
    isPost: boolean;
    cookies: Record<string, string>;
}) => Promise<{ options: ResolvedOptions }>;

const nodeRequire = createRequire(import.meta.url);
const nextAuthDir = path.dirname(nodeRequire.resolve('next-auth'));
const { init } = nodeRequire(path.join(nextAuthDir, 'core/init.js')) as { init: NextAuthInit };

async function resolvedByNextAuth(origin: string): Promise<ResolvedOptions> {
    const { options } = await init({
        authOptions,
        origin,
        action: 'session',
        isPost: false,
        cookies: {},
    });
    return options;
}

describe('sessionCookie()', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('uses the __Secure- name and secure flag over https', () => {
        vi.stubEnv('NEXTAUTH_URL', 'https://outpost.copilotkit.ai');
        expect(sessionCookie()).toEqual({
            name: '__Secure-next-auth.session-token',
            options: { httpOnly: true, sameSite: 'lax', path: '/', secure: true },
        });
    });

    it('uses the plain name over http', () => {
        vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
        expect(sessionCookie()).toEqual({
            name: 'next-auth.session-token',
            options: { httpOnly: true, sameSite: 'lax', path: '/', secure: false },
        });
    });

    it("matches NextAuth's default max age", () => {
        expect(DEFAULT_SESSION_MAX_AGE).toBe(30 * 24 * 60 * 60);
    });

    it('stays in sync with authOptions: no cookies or useSecureCookies override', () => {
        expect(authOptions.cookies).toBeUndefined();
        expect(authOptions.useSecureCookies).toBeUndefined();
    });

    it.each(['https://outpost.copilotkit.ai', 'http://localhost:3000'])(
        'equals the session cookie the installed next-auth resolves for authOptions at %s',
        async (url) => {
            vi.stubEnv('NEXTAUTH_URL', url);
            const resolved = await resolvedByNextAuth(url);
            expect(sessionCookie()).toEqual(resolved.cookies.sessionToken);
        },
    );

    it('falls back to the session maxAge the installed next-auth resolves for authOptions', async () => {
        const resolved = await resolvedByNextAuth('https://outpost.copilotkit.ai');
        // The expression a server-side re-issue uses for the cookie and JWT lifetime.
        expect(authOptions.session?.maxAge ?? DEFAULT_SESSION_MAX_AGE).toBe(
            resolved.session.maxAge,
        );
    });
});

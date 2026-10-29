/** NextAuth v4's default session lifetime, used when authOptions.session.maxAge is unset. */
export const DEFAULT_SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export interface SessionCookie {
    name: string;
    options: { httpOnly: true; sameSite: 'lax'; path: '/'; secure: boolean };
}

/**
 * The session cookie name and options NextAuth 4.24.14 uses by default
 * (core/lib/cookie.js defaultCookies(), core/init.js): `__Secure-` prefix and
 * `secure` when NEXTAUTH_URL is https. lib/auth.ts sets neither `cookies` nor
 * `useSecureCookies`, so these defaults apply; session-cookie.test.ts pins that, so
 * adding either override to authOptions must update this helper too.
 */
export function sessionCookie(): SessionCookie {
    const secure = (process.env.NEXTAUTH_URL ?? '').startsWith('https://');
    return {
        name: `${secure ? '__Secure-' : ''}next-auth.session-token`,
        options: { httpOnly: true, sameSite: 'lax', path: '/', secure },
    };
}

/**
 * next-auth 4.24.14 core/lib/cookie.js: CHUNK_SIZE = ALLOWED_COOKIE_SIZE (4096) -
 * ESTIMATED_EMPTY_COOKIE_SIZE (163). A session token longer than this is split.
 */
export const SESSION_COOKIE_CHUNK_SIZE = 4096 - 163;

export interface SessionCookieWrite {
    name: string;
    value: string;
    options: SessionCookie['options'] & { maxAge: number };
}

/**
 * The Set-Cookie writes that replace the session with `value`, the same way NextAuth
 * 4.24.14's SessionStore.chunk() does (core/lib/cookie.js; it is not exported).
 * First every request cookie whose name starts with the session cookie name is
 * expired, then the token is written as `name` when it fits in one chunk, or as
 * `name.0`, `name.1`, … when it does not. A write for the same name replaces the
 * expiry. Browsers drop a single cookie over 4096 bytes, so an unchunked large token
 * would sign the user out.
 */
export function sessionCookieWrites(
    cookie: SessionCookie,
    value: string,
    maxAge: number,
    requestCookieNames: string[],
): SessionCookieWrite[] {
    const writes = new Map<string, SessionCookieWrite>();
    for (const name of requestCookieNames) {
        if (name.startsWith(cookie.name)) {
            writes.set(name, { name, value: '', options: { ...cookie.options, maxAge: 0 } });
        }
    }
    const options = { ...cookie.options, maxAge };
    const count = Math.ceil(value.length / SESSION_COOKIE_CHUNK_SIZE);
    if (count <= 1) {
        writes.set(cookie.name, { name: cookie.name, value, options });
    } else {
        for (let i = 0; i < count; i++) {
            const name = `${cookie.name}.${i}`;
            const chunk = value.slice(
                i * SESSION_COOKIE_CHUNK_SIZE,
                (i + 1) * SESSION_COOKIE_CHUNK_SIZE,
            );
            writes.set(name, { name, value: chunk, options });
        }
    }
    return [...writes.values()];
}

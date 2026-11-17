// Paths that need no session. Shared by the middleware (which skips auth for them) and
// the client SessionGuard (which must not send an anonymous visitor on them to /login).
// Kept free of `next/server` so client code can import it.
//
// An entry matches the path itself or any path below it, never a sibling that only
// shares the prefix: '/login' covers '/login' and '/login/x' but not '/loginx'. An
// entry that ends in '/' matches only paths below it, so '/api/password-reset/' covers
// '/api/password-reset/request' but not the bare '/api/password-reset'.
//
// The middleware also skips the CSRF check for these paths, so each route carries its
// own check instead. The password-reset API routes reject any request whose
// Content-Type is not JSON (guardPublicResetRoute, outpost#206). The others rely on
// what their handlers do: next-auth checks its own CSRF token, /api/setup refuses once
// any member exists, invite acceptance needs the invite token, the Postmark webhook
// takes inbound mail and appends a reply only to an EMAIL ticket whose participant
// sent it, and /api/health is a read-only GET.
export const PUBLIC_PATHS = [
    '/login',
    '/api/auth',
    '/setup',
    '/api/setup',
    '/api/health',
    '/invite/accept',
    '/api/team/invite/accept',
    '/api/webhooks',
    '/forgot-password',
    '/reset-password',
    '/api/password-reset/',
];

// The segment-bounded prefix rule described above, for one entry. Also used by
// AppShell for its bare-page list.
export function matchesPathPrefix(pathname: string, prefix: string): boolean {
    return prefix.endsWith('/')
        ? pathname.startsWith(prefix)
        : pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isPublicPath(pathname: string): boolean {
    return PUBLIC_PATHS.some((p) => matchesPathPrefix(pathname, p));
}

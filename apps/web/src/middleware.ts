import { getToken } from 'next-auth/jwt';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requiresCsrfValidation, validateCsrfToken, setCsrfCookie } from '@/lib/csrf';

const PUBLIC_PATHS = ['/login', '/api/auth', '/setup', '/api/setup', '/api/health', '/invite/accept', '/api/team/invite/accept', '/api/webhooks'];

/**
 * Extensions served as static files out of `public/`.
 *
 * This replaces a bare `pathname.includes('.')` check. That heuristic treated ANY
 * dotted path as a static asset, and because it ran ahead of the auth and CSRF
 * checks below, `PATCH /api/accounts/x.json` reached the handler with neither
 * applied.
 *
 * Deliberately an allowlist of extensions rather than "has a dot": a request path
 * is attacker-controlled, so anything that decides "skip the security checks" has
 * to be a closed set. `public/` currently holds only `favicon.svg` and
 * `og-image.svg`; the rest of this list is the conventional static set. Note that
 * `.json` is NOT here — no unauthenticated JSON is served from `public/`, and
 * admitting it would re-open the exact shape of the original bug. If a
 * `manifest.json` is ever added, add it explicitly.
 *
 * If you add a file to `public/` whose extension is not here, the mistake is close to
 * invisible in development: an authenticated request falls through and is served
 * normally, so a logged-in developer sees nothing wrong. Only anonymous requesters get
 * the 302 — a broken `<img>` in a browser, and silently the wrong content type for an
 * OG unfurler or a crawler. Check this list, not your own browser.
 *
 * One deliberate behaviour change beyond the bypass itself: the old `includes('.')`
 * matched the dot inside `.well-known`, so that whole tree was blanket-exempt from
 * auth. It no longer is, and extension-less files under it (`acme-challenge/<token>`,
 * `apple-app-site-association`) now redirect to /login. Nothing in the repo requests
 * those and TLS terminates at the Railway edge, so ACME never reaches the app. Left
 * unexempted on purpose — a blanket unauthenticated subtree is the surface we just
 * finished removing. If a domain-verification file is ever needed there, exempt that
 * exact path rather than the tree.
 */
const STATIC_ASSET_PATH = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|txt|xml|webmanifest)$/i;

export async function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl;

    // Resolved first and used to gate the static-asset bypass below, so that no
    // convenience check can ever preempt auth or CSRF for an API route.
    const isApiRoute = pathname.startsWith('/api/');

    // Allow public paths
    if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
        return setCsrfCookie(request, NextResponse.next());
    }

    // Allow static assets and Next.js internals. Never applies under /api/, and
    // matches only known asset extensions — see STATIC_ASSET_PATH above.
    if (
        !isApiRoute &&
        (pathname.startsWith('/_next') ||
            pathname.startsWith('/favicon') ||
            STATIC_ASSET_PATH.test(pathname))
    ) {
        return NextResponse.next();
    }

    const token = await getToken({
        req: request,
        secret: process.env.NEXTAUTH_SECRET,
    });

    if (!token) {
        const loginUrl = new URL('/login', request.url);
        loginUrl.searchParams.set('callbackUrl', pathname);
        return NextResponse.redirect(loginUrl);
    }

    // CSRF: reject mutating requests to protected API routes without a valid token
    if (requiresCsrfValidation(request)) {
        const rejection = validateCsrfToken(request);
        if (rejection) return setCsrfCookie(request, rejection);
    }

    return setCsrfCookie(request, NextResponse.next());
}

export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { isPublicPath } from '@/lib/public-paths';

/**
 * Reads /api/auth/session directly and reports whether the server confirmed that
 * there is no session: a 200 with no user in the body. A network error, a non-2xx
 * response or a body that is not JSON is not a confirmation.
 */
async function sessionConfirmedEnded(): Promise<boolean> {
    try {
        const res = await fetch('/api/auth/session', {
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) return false;
        const body: unknown = await res.json();
        return typeof body === 'object' && body !== null && !('user' in body && body.user);
    } catch {
        return false;
    }
}

/**
 * Sends a session that has ended to /login.
 *
 * The middleware runs on the edge and only decodes the JWT, so a revoked session
 * (password changed elsewhere, member removed) still loads protected pages. The
 * revocation check runs in the jwt callback when the client reads /api/auth/session:
 * that read clears the cookie and leaves useSession() 'unauthenticated'. Without this
 * guard the open page would stay put with every API call returning 401.
 *
 * next-auth also reports 'unauthenticated' when that read fails (offline, a proxy 502,
 * a 500), so the status alone is not proof. Before redirecting, the guard reads the
 * session once more itself and redirects only when the server answers 200 with no
 * user. If that read fails too, the guard stays put and checks again the next time
 * the tab becomes visible.
 */
export function SessionGuard() {
    const { status } = useSession();
    const pathname = usePathname();
    const router = useRouter();

    useEffect(() => {
        if (status !== 'unauthenticated' || isPublicPath(pathname)) return;

        let cancelled = false;
        let checking = false;
        const check = async () => {
            if (checking) return;
            checking = true;
            const ended = await sessionConfirmedEnded();
            checking = false;
            if (cancelled || !ended) return;
            // Same shape as the middleware's redirect for a missing token.
            router.replace(`/login?callbackUrl=${encodeURIComponent(pathname)}`);
        };
        const onVisible = () => {
            if (document.visibilityState === 'visible') void check();
        };

        void check();
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [status, pathname, router]);

    return null;
}

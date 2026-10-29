'use client';

import { usePathname } from 'next/navigation';
import { Sidebar, MobileNav } from '@/components/sidebar';
import { KeyboardShortcutProvider } from '@/components/keyboard-shortcut-provider';
import { cn } from '@/lib/utils';
import { matchesPathPrefix } from '@/lib/public-paths';

// Pages that render bare, without the sidebar and mobile nav. Separate from the
// middleware's PUBLIC_PATHS (lib/public-paths.ts), which decides auth, not chrome.
const BARE_PATHS = ['/login', '/setup', '/invite', '/forgot-password', '/reset-password'];

// Routes that manage their own padding and want to fill the full main area.
const FULLBLEED_PATHS = ['/tickets'];

// Matches the path itself or any path below it, never a sibling that only shares the
// prefix: '/login' covers '/login/x' but not '/loginx' (same rule as isPublicPath).
function isBarePath(pathname: string): boolean {
    return BARE_PATHS.some((p) => matchesPathPrefix(pathname, p));
}

export function AppShell({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const isPublic = isBarePath(pathname);
    const isFullBleed = FULLBLEED_PATHS.some((p) => pathname.startsWith(p));

    if (isPublic) {
        return <>{children}</>;
    }

    return (
        <div className="flex h-screen">
            <Sidebar />
            <main
                className={cn(
                    'flex-1 min-w-0',
                    isFullBleed
                        ? 'overflow-hidden pb-14 md:pb-0'
                        : 'overflow-auto p-6 pb-20 md:pb-6',
                )}
            >
                <KeyboardShortcutProvider />
                {children}
            </main>
            <MobileNav />
        </div>
    );
}

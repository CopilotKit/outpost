import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppShell } from '@/components/app-shell';

const mockPathname = vi.fn().mockReturnValue('/dashboard');
vi.mock('next/navigation', () => ({
    usePathname: () => mockPathname(),
}));

// The shell's own logic is only which paths get the sidebar; stand in for the chrome.
vi.mock('@/components/sidebar', () => ({
    Sidebar: () => <aside data-testid="sidebar" />,
    MobileNav: () => <nav data-testid="mobile-nav" />,
}));
vi.mock('@/components/keyboard-shortcut-provider', () => ({
    KeyboardShortcutProvider: () => null,
}));

function renderAt(pathname: string) {
    mockPathname.mockReturnValue(pathname);
    return render(
        <AppShell>
            <p>page body</p>
        </AppShell>,
    );
}

function hasShell(): boolean {
    return screen.queryByTestId('sidebar') !== null || screen.queryByTestId('mobile-nav') !== null;
}

describe('AppShell', () => {
    it.each([
        '/login',
        '/setup',
        '/invite/accept',
        '/forgot-password',
        '/reset-password',
        '/reset-password/',
    ])('renders %s bare, without the sidebar or mobile nav', (pathname) => {
        renderAt(pathname);
        expect(screen.getByText('page body')).toBeInTheDocument();
        expect(hasShell()).toBe(false);
    });

    it.each(['/dashboard', '/tickets', '/settings/team', '/'])(
        'renders %s inside the shell',
        (pathname) => {
            renderAt(pathname);
            expect(screen.getByText('page body')).toBeInTheDocument();
            expect(screen.getByTestId('sidebar')).toBeInTheDocument();
            expect(screen.getByTestId('mobile-nav')).toBeInTheDocument();
        },
    );

    // A bare-page entry covers the path and paths below it, never a sibling that only
    // shares the prefix (same rule as isPublicPath in lib/public-paths.ts).
    it.each(['/loginx', '/setup-guide', '/invitesx', '/reset-passwords', '/forgot-password-help'])(
        'keeps the shell on %s, which only shares a prefix with a bare page',
        (pathname) => {
            renderAt(pathname);
            expect(hasShell()).toBe(true);
        },
    );
});

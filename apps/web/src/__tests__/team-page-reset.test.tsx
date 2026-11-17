import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';

// Stable objects: the page lists `router` in effect and callback dependencies, so a
// fresh object per render would refetch forever. SESSION is mutated per test for the
// non-admin case.
const ROUTER = { replace: vi.fn() };
const SESSION = {
    data: { user: { role: 'ADMIN', memberId: 'admin-1' } },
    status: 'authenticated',
};
vi.mock('next/navigation', () => ({ useRouter: () => ROUTER }));
vi.mock('next-auth/react', () => ({ useSession: () => SESSION }));
vi.mock('@/components/page-header', () => ({ PageHeader: () => null }));

import TeamPage from '@/app/settings/team/page';

const CSRF = 'csrf-token-abc';
const base = {
    name: '',
    role: 'MEMBER',
    avatarUrl: null,
    invitedAt: null,
    joinedAt: null,
    createdAt: '2026-10-01T00:00:00Z',
};
const MEMBERS = [
    {
        ...base,
        id: 'admin-1',
        email: 'admin@x.io',
        role: 'ADMIN',
        status: 'ACTIVE',
        hasPassword: true,
    },
    { ...base, id: 'm2', email: 'bob@x.io', status: 'ACTIVE', hasPassword: true },
    { ...base, id: 'm3', email: 'sso@x.io', status: 'ACTIVE', hasPassword: false },
    { ...base, id: 'm4', email: 'off@x.io', status: 'DISABLED', hasPassword: true },
    { ...base, id: 'm5', email: 'new@x.io', status: 'INVITED', hasPassword: false },
];

// Only `fetch` is faked: the page's real `apiFetch` runs, so the CSRF header it adds
// from the `csrf` cookie is what reaches the network layer.
const mockFetch = vi.fn();

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function respondReset(status: number, body: unknown) {
    mockFetch.mockImplementation(async (url: string) =>
        url === '/api/team' ? json(200, MEMBERS) : json(status, body),
    );
}

function resetCalls() {
    return mockFetch.mock.calls.filter(([url]) => url === '/api/team/m2/password-reset');
}

const TITLE = 'Send password reset link';

describe('Settings → Team reset button', () => {
    beforeEach(() => {
        mockFetch.mockReset();
        ROUTER.replace.mockReset();
        SESSION.data.user.role = 'ADMIN';
        vi.stubGlobal('fetch', mockFetch);
        document.cookie = `csrf=${CSRF}`;
        vi.spyOn(window, 'confirm').mockReturnValue(true);
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('shows the button only for other ACTIVE members with a password', async () => {
        respondReset(200, { ok: true, emailSent: true });
        render(<TeamPage />);
        await screen.findByText('bob@x.io');

        expect(screen.getAllByTitle(TITLE)).toHaveLength(1);
        const row = screen.getByText('bob@x.io').closest('tr')!;
        expect(within(row).getByTitle(TITLE)).toBeInTheDocument();
        for (const email of ['admin@x.io', 'sso@x.io', 'off@x.io', 'new@x.io']) {
            const other = screen.getByText(email).closest('tr')!;
            expect(within(other).queryByTitle(TITLE)).toBeNull();
        }
    });

    it('does not show the button to a non-admin', async () => {
        SESSION.data.user.role = 'MEMBER';
        respondReset(200, { ok: true, emailSent: true });
        render(<TeamPage />);

        await waitFor(() => expect(ROUTER.replace).toHaveBeenCalledWith('/dashboard'));
        expect(screen.queryByTitle(TITLE)).toBeNull();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not show the button outside credentials mode', async () => {
        vi.stubEnv('NEXT_PUBLIC_AUTH_PROVIDER', 'oidc');
        vi.resetModules();
        const { default: OidcTeamPage } = await import('@/app/settings/team/page');
        respondReset(200, { ok: true, emailSent: true });
        render(<OidcTeamPage />);
        await screen.findByText('bob@x.io');

        expect(screen.queryByTitle(TITLE)).toBeNull();
    });

    it('confirms, posts with the CSRF token, and shows the success notice', async () => {
        respondReset(200, { ok: true, emailSent: true });
        render(<TeamPage />);
        fireEvent.click(await screen.findByTitle(TITLE));

        expect(window.confirm).toHaveBeenCalledWith(
            'Send a password reset link to bob@x.io? Their current password keeps working until they use the link.',
        );
        expect(
            await screen.findByText(
                'Password reset link sent to bob@x.io. It expires in 30 minutes.',
            ),
        ).toBeInTheDocument();

        const calls = resetCalls();
        expect(calls).toHaveLength(1);
        const init = calls[0][1] as RequestInit;
        expect(init.method).toBe('POST');
        expect(new Headers(init.headers).get('X-CSRF-Token')).toBe(CSRF);
    });

    it('does nothing when the confirm is cancelled', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(false);
        respondReset(200, { ok: true, emailSent: true });
        render(<TeamPage />);
        fireEvent.click(await screen.findByTitle(TITLE));
        expect(resetCalls()).toHaveLength(0);
    });

    it('disables the row button while sending', async () => {
        let resolve!: (v: Response) => void;
        mockFetch.mockImplementation((url: string) =>
            url === '/api/team'
                ? Promise.resolve(json(200, MEMBERS))
                : new Promise<Response>((r) => {
                      resolve = r;
                  }),
        );
        render(<TeamPage />);
        const button = await screen.findByTitle(TITLE);
        fireEvent.click(button);
        await waitFor(() => expect(button).toBeDisabled());
        resolve(json(200, { ok: true, emailSent: true }));
        await waitFor(() => expect(button).not.toBeDisabled());
    });

    it.each([
        [
            200,
            { ok: true, emailSent: false },
            'The reset link could not be emailed. Check the email settings and try again.',
        ],
        // Failed sends count toward the limit, so this copy must not say a link was sent.
        [429, { error: 'x' }, 'Too many reset attempts for this member. Try again later.'],
        [
            409,
            { error: 'This member has no password to reset.' },
            'This member has no password to reset.',
        ],
        [403, { error: 'Forbidden' }, 'Something went wrong. Try again.'],
    ])('status %s shows the right banner', async (status, body, message) => {
        respondReset(status, body);
        render(<TeamPage />);
        fireEvent.click(await screen.findByTitle(TITLE));
        expect(await screen.findByText(message)).toBeInTheDocument();
        expect(
            screen.queryByText('Password reset link sent to bob@x.io. It expires in 30 minutes.'),
        ).toBeNull();
        expect(screen.queryByText(/was sent/)).toBeNull();
    });
});

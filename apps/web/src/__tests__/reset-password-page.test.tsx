import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockReplace }) }));

import ResetPasswordPage from '@/app/reset-password/page';

const token = 'f'.repeat(64);
const EXPIRED = 'This reset link is invalid or has expired.';
const RATE_LIMITED = 'Too many requests. Try again in a few minutes.';
const VERIFY_FAILED = 'We could not check your link. Try again.';
const VERIFY_URL = '/api/password-reset/verify';
const CONFIRM_URL = '/api/password-reset/confirm';

type Reply = { status: number; body: unknown } | 'reject';

// Fetch calls to a URL that has no handler. Checked after every test, so a page
// that calls the wrong URL fails loudly instead of landing in its own .catch.
let unexpectedUrls: string[] = [];

/**
 * Stub fetch per URL. A handler is one reply, or a list used in order (the last
 * one repeats). 'reject' makes fetch reject, as a network failure does.
 */
function routeFetch(handlers: Record<string, Reply | Reply[]>) {
    const calls: Record<string, number> = {};
    global.fetch = vi.fn(async (url: string) => {
        const handler = handlers[url];
        if (!handler) {
            unexpectedUrls.push(url);
            throw new Error(`routeFetch: unexpected URL ${url}`);
        }
        const n = calls[url] ?? 0;
        calls[url] = n + 1;
        const reply = Array.isArray(handler) ? handler[Math.min(n, handler.length - 1)] : handler;
        if (reply === 'reject') throw new TypeError('Failed to fetch');
        return { status: reply.status, ok: reply.status < 300, json: async () => reply.body };
    }) as never;
}

function fetchedUrls(): string[] {
    return vi.mocked(global.fetch).mock.calls.map(([url]) => String(url));
}

function verifyCalls() {
    return vi.mocked(global.fetch).mock.calls.filter(([url]) => url === VERIFY_URL);
}

describe('/reset-password', () => {
    beforeEach(() => {
        mockReplace.mockReset();
        unexpectedUrls = [];
        window.history.replaceState(null, '', `/reset-password#token=${token}`);
    });

    afterEach(() => {
        expect(unexpectedUrls).toEqual([]);
    });

    it('strips the fragment at once, keeps the token out of storage, and verifies it', async () => {
        const setItem = vi.spyOn(Storage.prototype, 'setItem');
        routeFetch({ [VERIFY_URL]: { status: 200, body: { ok: true } } });

        render(<ResetPasswordPage />);

        expect(window.location.hash).toBe('');
        expect(window.location.pathname).toBe('/reset-password');
        await waitFor(() => expect(screen.getByLabelText('New password')).toBeInTheDocument());
        expect(global.fetch).toHaveBeenCalledWith(
            VERIFY_URL,
            expect.objectContaining({
                body: JSON.stringify({ token }),
            }),
        );
        // The token travels in the POST body only, never in a URL.
        expect(fetchedUrls().every((url) => !url.includes(token) && !url.includes('?'))).toBe(true);
        expect(setItem).not.toHaveBeenCalled();
        expect(screen.getByText('At least 8 characters')).toBeInTheDocument();
    });

    it('shows the expired state with no token', async () => {
        window.history.replaceState(null, '', '/reset-password');
        routeFetch({});
        render(<ResetPasswordPage />);
        expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
            'href',
            '/forgot-password',
        );
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('shows the expired state with a malformed token, without calling verify', async () => {
        window.history.replaceState(null, '', '/reset-password#token=not-hex');
        routeFetch({});
        render(<ResetPasswordPage />);
        expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
        expect(window.location.hash).toBe('');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('shows the expired state when verify 410s', async () => {
        routeFetch({ [VERIFY_URL]: { status: 410, body: { error: EXPIRED } } });
        render(<ResetPasswordPage />);
        expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
        expect(fetchedUrls()).toEqual([VERIFY_URL]);
        expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    });

    it.each([
        ['500', { status: 500, body: { error: 'Something went wrong. Try again.' } }],
        ['503', { status: 503, body: {} }],
        ['404', { status: 404, body: { error: 'Not found' } }],
        ['a network failure', 'reject'],
    ] as const)(
        'does not call the link expired when verify fails with %s, and Try again re-verifies the same token',
        async (_label, failure) => {
            routeFetch({ [VERIFY_URL]: [failure, { status: 200, body: { ok: true } }] });
            render(<ResetPasswordPage />);

            expect(await screen.findByText(VERIFY_FAILED)).toBeInTheDocument();
            expect(screen.queryByText(EXPIRED)).not.toBeInTheDocument();
            expect(verifyCalls()).toHaveLength(1);

            fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

            expect(await screen.findByLabelText('New password')).toBeInTheDocument();
            expect(verifyCalls()).toHaveLength(2);
            for (const [, init] of verifyCalls()) {
                expect(init).toEqual(expect.objectContaining({ body: JSON.stringify({ token }) }));
            }
        },
    );

    it('shows the rate-limit message when verify 429s, and Try again re-verifies the same token', async () => {
        routeFetch({
            [VERIFY_URL]: [
                { status: 429, body: {} },
                { status: 200, body: { ok: true } },
            ],
        });
        render(<ResetPasswordPage />);
        expect(await screen.findByText(RATE_LIMITED)).toBeInTheDocument();
        expect(screen.queryByText(EXPIRED)).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

        expect(await screen.findByLabelText('New password')).toBeInTheDocument();
        expect(verifyCalls()).toHaveLength(2);
        expect(verifyCalls()[1][1]).toEqual(
            expect.objectContaining({ body: JSON.stringify({ token }) }),
        );
    });

    it('shows the expired state when a retried verify 410s', async () => {
        routeFetch({
            [VERIFY_URL]: [
                { status: 500, body: {} },
                { status: 410, body: { error: EXPIRED } },
            ],
        });
        render(<ResetPasswordPage />);
        fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
        expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    });

    async function fillAndSubmit(confirmResult: Reply) {
        routeFetch({
            [VERIFY_URL]: { status: 200, body: { ok: true } },
            [CONFIRM_URL]: confirmResult,
        });
        render(<ResetPasswordPage />);
        fireEvent.change(await screen.findByLabelText('New password'), {
            target: { value: 'new-pass-1' },
        });
        fireEvent.change(screen.getByLabelText('Confirm new password'), {
            target: { value: 'new-pass-1' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    }

    it('redirects to /login?reset=1 on success', async () => {
        await fillAndSubmit({ status: 200, body: { ok: true } });
        await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login?reset=1'));
        expect(global.fetch).toHaveBeenCalledWith(
            CONFIRM_URL,
            expect.objectContaining({
                body: JSON.stringify({
                    token,
                    password: 'new-pass-1',
                    confirmPassword: 'new-pass-1',
                }),
            }),
        );
        expect(fetchedUrls().every((url) => !url.includes(token) && !url.includes('?'))).toBe(true);
    });

    it('lists 400 errors inline', async () => {
        await fillAndSubmit({
            status: 400,
            body: { errors: ['Password must be 72 bytes or fewer.'] },
        });
        expect(await screen.findByText('Password must be 72 bytes or fewer.')).toBeInTheDocument();
        expect(mockReplace).not.toHaveBeenCalled();
    });

    it('switches to the expired state on a 410 at submit', async () => {
        await fillAndSubmit({ status: 410, body: { error: EXPIRED } });
        expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    });

    it.each([
        ['429', { status: 429, body: {} }, RATE_LIMITED],
        ['500', { status: 500, body: { error: 'x' } }, 'Something went wrong. Try again.'],
        ['a network failure', 'reject', 'Something went wrong. Try again.'],
    ] as const)(
        'keeps the form with the button re-enabled when confirm fails with %s',
        async (_label, failure, message) => {
            await fillAndSubmit(failure);
            expect(await screen.findByText(message)).toBeInTheDocument();
            const button = screen.getByRole('button', { name: 'Set new password' });
            await waitFor(() => expect(button).toBeEnabled());
            expect(screen.getByLabelText('New password')).toHaveValue('new-pass-1');
            expect(screen.queryByText(EXPIRED)).not.toBeInTheDocument();
            expect(mockReplace).not.toHaveBeenCalled();
        },
    );
});

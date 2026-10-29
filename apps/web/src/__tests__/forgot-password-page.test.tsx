import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

let search = new URLSearchParams();
vi.mock('next/navigation', () => ({ useSearchParams: () => search }));

import ForgotPasswordPage from '@/app/forgot-password/page';

const NEUTRAL =
    "If an account exists for that address, we've sent a link to reset your password. The link expires in 30 minutes.";

// Words that would reveal whether the account exists.
const ENUMERATION =
    /not found|no account|does not exist|doesn't exist|unknown (email|user|account)|not registered/i;

function respond(status: number, body: unknown) {
    global.fetch = vi
        .fn()
        .mockResolvedValue({ status, ok: status < 300, json: async () => body }) as never;
}

async function submit(email = 'alex@acme.test') {
    const view = render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    return view;
}

describe('/forgot-password', () => {
    beforeEach(() => {
        search = new URLSearchParams();
    });

    it('posts JSON and replaces the form with the neutral text', async () => {
        respond(200, { ok: true });
        await submit();
        await waitFor(() => expect(screen.getByText(NEUTRAL)).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: 'Send reset link' })).toBeNull();
        expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute(
            'href',
            '/login',
        );
        expect(global.fetch).toHaveBeenCalledWith(
            '/api/password-reset/request',
            expect.objectContaining({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'alex@acme.test' }),
            }),
        );
    });

    it('shows the same confirmation for every 200, whatever the body, and never says whether the account exists', async () => {
        const texts: string[] = [];
        for (const [email, body] of [
            ['alex@acme.test', { ok: true }],
            ['nobody@acme.test', {}],
            ['other@acme.test', { ok: false, error: 'No account found.' }],
        ] as const) {
            respond(200, body);
            const view = await submit(email);
            await waitFor(() => expect(screen.getByText(NEUTRAL)).toBeInTheDocument());
            texts.push(view.container.textContent ?? '');
            expect(view.container.textContent).not.toMatch(ENUMERATION);
            view.unmount();
        }
        expect(new Set(texts).size).toBe(1);
    });

    it('shows the 400 error inline', async () => {
        respond(400, { error: 'Enter a valid email address.' });
        await submit('x@y.z');
        await waitFor(() =>
            expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument(),
        );
        expect(screen.queryByText(NEUTRAL)).toBeNull();
    });

    it('shows the 429 message', async () => {
        respond(429, { error: 'Too many requests. Try again later.' });
        const view = await submit();
        await waitFor(() =>
            expect(
                screen.getByText('Too many requests. Try again in a few minutes.'),
            ).toBeInTheDocument(),
        );
        expect(screen.queryByText(NEUTRAL)).toBeNull();
        expect(view.container.textContent).not.toMatch(ENUMERATION);
    });

    it('shows a generic error for 5xx', async () => {
        respond(500, {});
        await submit();
        await waitFor(() =>
            expect(screen.getByText('Something went wrong. Try again.')).toBeInTheDocument(),
        );
        expect(screen.queryByText(NEUTRAL)).toBeNull();
    });

    it('shows a generic error on network failure', async () => {
        global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as never;
        await submit();
        await waitFor(() =>
            expect(screen.getByText('Something went wrong. Try again.')).toBeInTheDocument(),
        );
        expect(screen.getByRole('button', { name: 'Send reset link' })).not.toBeDisabled();
    });

    it('pre-fills ?email=', () => {
        search = new URLSearchParams('email=alex%40acme.test');
        render(<ForgotPasswordPage />);
        expect(screen.getByLabelText('Email')).toHaveValue('alex@acme.test');
    });

    it('links back to sign in from the form', () => {
        render(<ForgotPasswordPage />);
        expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute(
            'href',
            '/login',
        );
    });
});

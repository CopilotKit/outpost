import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

let search = new URLSearchParams();
vi.mock('next/navigation', () => ({ useSearchParams: () => search }));
vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));

import LoginPage from '@/app/login/page';

describe('login page', () => {
    beforeEach(() => {
        search = new URLSearchParams();
        global.fetch = vi.fn().mockResolvedValue({ status: 403 }) as never;
    });

    it('links to /forgot-password and carries the typed email', () => {
        render(<LoginPage />);
        const link = screen.getByRole('link', { name: 'Forgot password?' });
        expect(link).toHaveAttribute('href', '/forgot-password');

        fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'alex@acme.test' } });
        expect(link).toHaveAttribute('href', '/forgot-password?email=alex%40acme.test');
    });

    it('shows the reset banner on ?reset=1', () => {
        search = new URLSearchParams('reset=1');
        render(<LoginPage />);
        expect(
            screen.getByText('Your password has been reset. Sign in with your new password.'),
        ).toBeInTheDocument();
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockReplace = vi.fn();
const mockUpdate = vi.fn();
// Stable objects: the page lists `session` in an effect dependency array, so a fresh
// object per render would refetch forever.
const ROUTER = { replace: mockReplace };
const SESSION = { data: { user: { name: 'Alice' } }, update: mockUpdate };
vi.mock('next/navigation', () => ({ useRouter: () => ROUTER }));
vi.mock('next-auth/react', () => ({ useSession: () => SESSION }));
vi.mock('@/components/page-header', () => ({ PageHeader: () => null }));

const mockApiFetch = vi.fn();
vi.mock('@/lib/api-fetch', () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }));

import ProfilePage from '@/app/settings/profile/page';

const profile = { id: 'm1', name: 'Alice', email: 'alice@x.io', avatarUrl: null, role: 'MEMBER' };

function respondPut(status: number, body: unknown) {
    mockApiFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === 'PUT'
            ? { status, ok: status < 300, json: async () => body }
            : { status: 200, ok: true, json: async () => profile },
    );
}

async function changePassword() {
    render(<ProfilePage />);
    fireEvent.change(await screen.findByLabelText('Current Password'), {
        target: { value: 'oldpass123' },
    });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'newpass1234' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), {
        target: { value: 'newpass1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
}

describe('profile page password change', () => {
    beforeEach(() => {
        mockReplace.mockReset();
        mockUpdate.mockReset();
        mockApiFetch.mockReset();
    });

    it('says the other sessions were signed out', async () => {
        respondPut(200, profile);
        await changePassword();
        expect(
            await screen.findByText('Password changed. Your other sessions have been signed out.'),
        ).toBeInTheDocument();
        expect(mockReplace).not.toHaveBeenCalled();
        // The server re-issues the session cookie; the client must not race it with update().
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('redirects to /login on 401', async () => {
        respondPut(401, { error: 'Your session has ended. Sign in again.' });
        await changePassword();
        await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
        expect(
            screen.queryByText('Your session has ended. Sign in again.'),
        ).not.toBeInTheDocument();
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('keeps the plain message for a name-only save', async () => {
        respondPut(200, profile);
        render(<ProfilePage />);
        await screen.findByLabelText('Current Password');
        fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
        expect(await screen.findByText('Profile updated successfully.')).toBeInTheDocument();
        expect(mockReplace).not.toHaveBeenCalled();
    });
});

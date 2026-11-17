import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { SessionGuard } from '@/components/session-guard';

const replace = vi.fn();
const mockPathname = vi.fn();
vi.mock('next/navigation', () => ({
    usePathname: () => mockPathname(),
    useRouter: () => ({ replace }),
}));

const mockStatus = vi.fn();
vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: null, status: mockStatus() }),
}));

// The guard's own confirmation read of /api/auth/session.
const fetchMock = vi.fn();

async function flush() {
    await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
    });
}

describe('SessionGuard', () => {
    beforeEach(() => {
        replace.mockReset();
        fetchMock.mockReset();
        fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        mockPathname.mockReturnValue('/dashboard');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends a confirmed-ended session on a protected page to /login', async () => {
        mockStatus.mockReturnValue('unauthenticated');
        render(<SessionGuard />);
        await waitFor(() =>
            expect(replace).toHaveBeenCalledWith('/login?callbackUrl=%2Fdashboard'),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/auth/session',
            expect.objectContaining({ cache: 'no-store' }),
        );
    });

    it.each([
        ['the read rejects', () => Promise.reject(new TypeError('Failed to fetch'))],
        [
            'the read returns 502',
            () => Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 })),
        ],
        [
            'the read returns 500',
            () => Promise.resolve(new Response('{"message":"x"}', { status: 500 })),
        ],
        [
            'the body is not JSON',
            () => Promise.resolve(new Response('<html></html>', { status: 200 })),
        ],
        [
            'the read finds a user',
            () =>
                Promise.resolve(
                    new Response(JSON.stringify({ user: { id: 'm1' } }), { status: 200 }),
                ),
        ],
    ])('stays put when %s', async (_label, impl) => {
        fetchMock.mockImplementation(impl);
        mockStatus.mockReturnValue('unauthenticated');
        render(<SessionGuard />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await flush();
        expect(replace).not.toHaveBeenCalled();
    });

    it('does not redirect if it unmounts before the confirmation read returns', async () => {
        let resolve!: (r: Response) => void;
        fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
        mockStatus.mockReturnValue('unauthenticated');
        const { unmount } = render(<SessionGuard />);
        unmount();
        resolve(new Response('{}', { status: 200 }));
        await flush();
        expect(replace).not.toHaveBeenCalled();
    });

    it('leaves an authenticated session where it is', async () => {
        mockStatus.mockReturnValue('authenticated');
        render(<SessionGuard />);
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
    });

    it('does not redirect while the session is still loading', async () => {
        mockStatus.mockReturnValue('loading');
        render(<SessionGuard />);
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
    });

    it.each(['/login', '/forgot-password', '/reset-password', '/setup', '/invite/accept'])(
        'leaves an anonymous visitor on public page %s',
        async (pathname) => {
            mockPathname.mockReturnValue(pathname);
            mockStatus.mockReturnValue('unauthenticated');
            render(<SessionGuard />);
            await flush();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(replace).not.toHaveBeenCalled();
        },
    );
});

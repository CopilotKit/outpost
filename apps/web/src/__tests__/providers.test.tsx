// Drives the real next-auth SessionProvider and SessionGuard through Providers.
// Only fetch (the transport) and next/navigation (the router) are stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { Providers } from '@/components/providers';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
    usePathname: () => '/dashboard',
    useRouter: () => ({ replace }),
}));

const VALID = () =>
    new Response(JSON.stringify({ user: { id: 'm1' }, expires: '2099-01-01' }), { status: 200 });
const REVOKED = () => new Response('{}', { status: 200 });
const BAD_GATEWAY = () => new Response('<html>Bad Gateway</html>', { status: 502 });
const SERVER_ERROR = () => new Response('{"message":"x"}', { status: 500 });
const OFFLINE = (): Response => {
    throw new TypeError('Failed to fetch');
};

let sessionResponse: () => Response;
let fetchMock: ReturnType<typeof vi.fn>;

const sessionReads = () =>
    fetchMock.mock.calls.filter(([url]) => String(url) === '/api/auth/session').length;

async function settle(ms = 100) {
    await act(async () => {
        await new Promise((r) => setTimeout(r, ms));
    });
}

function renderProviders() {
    return render(
        <Providers>
            <div>page</div>
        </Providers>,
    );
}

async function refocus() {
    // next-auth throttles refetches by whole seconds since the last sync.
    await settle(1100);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
    });
}

describe('Providers + SessionGuard under the real SessionProvider', () => {
    beforeEach(() => {
        replace.mockReset();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        fetchMock = vi.fn(async (url: RequestInfo | URL) => {
            const u = String(url);
            if (u === '/api/auth/session') return sessionResponse();
            if (u === '/api/auth/_log') return new Response('{}', { status: 200 });
            throw new Error(`unexpected fetch ${u}`);
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('leaves a valid session where it is', async () => {
        sessionResponse = VALID;
        renderProviders();
        await waitFor(() => expect(sessionReads()).toBeGreaterThan(0));
        await settle();
        expect(replace).not.toHaveBeenCalled();
    });

    it('renders SessionGuard: a revoked session (200 with no user) goes to /login', async () => {
        sessionResponse = REVOKED;
        renderProviders();
        await waitFor(() =>
            expect(replace).toHaveBeenCalledWith('/login?callbackUrl=%2Fdashboard'),
        );
    });

    it.each([
        ['fetch rejects (offline)', OFFLINE],
        ['502 html from a proxy', BAD_GATEWAY],
        ['500 json', SERVER_ERROR],
    ])('does not redirect when the session read fails: %s', async (_label, response) => {
        sessionResponse = response;
        renderProviders();
        // next-auth's read, then the guard's own confirmation read.
        await waitFor(() => expect(sessionReads()).toBeGreaterThanOrEqual(2));
        await settle();
        expect(replace).not.toHaveBeenCalled();
    });

    it('does not redirect when a refocus read of a valid session hits a 502', async () => {
        sessionResponse = VALID;
        renderProviders();
        await waitFor(() => expect(sessionReads()).toBe(1));
        sessionResponse = BAD_GATEWAY;
        await refocus();
        await waitFor(() => expect(sessionReads()).toBeGreaterThanOrEqual(3));
        await settle();
        expect(replace).not.toHaveBeenCalled();
    });

    it('redirects on a later refocus once the server confirms the session ended', async () => {
        sessionResponse = BAD_GATEWAY;
        renderProviders();
        await waitFor(() => expect(sessionReads()).toBeGreaterThanOrEqual(2));
        await settle();
        expect(replace).not.toHaveBeenCalled();
        sessionResponse = REVOKED;
        await refocus();
        await waitFor(() =>
            expect(replace).toHaveBeenCalledWith('/login?callbackUrl=%2Fdashboard'),
        );
    });
});

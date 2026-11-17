/**
 * The dashboard and its widgets must show an error, not a success or empty state, when an
 * API call fails.
 *
 * A revoked session opens /dashboard and every `/api/dashboard/*` call returns 401 with an
 * `{ error }` body. Storing that body as data crashed the render ("Cannot read properties
 * of undefined (reading 'length')"), which kept SessionGuard's redirect to /login from
 * completing. The first fix kept the empty states instead, but those make claims: on a 500,
 * My Tasks said "All caught up — No tasks assigned to you. Nice work!" and the FAQ said
 * "No FAQs available yet". A failed month switch also left the previous month's numbers on
 * screen under the newly selected month.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import DashboardPage from '@/app/dashboard/page';
import { FaqSection } from '@/components/dashboard/faq-section';
import { MyTasks } from '@/components/dashboard/my-tasks';

// Mock recharts to avoid canvas/SVG issues in jsdom
vi.mock('recharts', () => {
    const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
    const Leaf = () => <div />;
    return {
        ResponsiveContainer: Passthrough,
        AreaChart: Passthrough,
        Area: Leaf,
        XAxis: Leaf,
        YAxis: Leaf,
        CartesianGrid: Leaf,
        Tooltip: Leaf,
    };
});

function failure(status: number) {
    return {
        ok: false,
        status,
        json: async () => ({ error: status === 401 ? 'Unauthorized' : 'Internal error' }),
    };
}

function ok(body: unknown) {
    return { ok: true, status: 200, json: async () => body };
}

function stubFetchStatus(status: number) {
    const fetchMock = vi.fn(() => Promise.resolve(failure(status)));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function statsBody(monthKey: string, month: string, totalTickets: number) {
    return {
        slaBreaches: 2,
        avgFirstResponseMs: 60000,
        avgResolutionMs: 120000,
        totalTickets,
        openTickets: totalTickets,
        trend: [{ day: 1, count: totalTickets }],
        month,
        monthKey,
        availableMonths: ['2026-05', '2026-06', '2026-07'],
        year: 2026,
    };
}

function expectNoSuccessCopy() {
    expect(screen.queryByText('All caught up')).not.toBeInTheDocument();
    expect(screen.queryByText(/Nice work/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('faq-empty')).not.toBeInTheDocument();
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe.each([401, 500])('dashboard on a %i response', (status) => {
    it('renders the whole page with error indications instead of crashing', async () => {
        const fetchMock = stubFetchStatus(status);

        render(<DashboardPage />);

        await waitFor(() => expect(screen.getByTestId('my-tasks-error')).toBeInTheDocument());
        await waitFor(() => expect(screen.getByTestId('faq-error')).toBeInTheDocument());
        await waitFor(() => expect(screen.getByTestId('stats-error')).toBeInTheDocument());
        expectNoSuccessCopy();
        expect(screen.queryByTestId('trend-total')).not.toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith('/api/dashboard/stats');
        // The SLA cards keep their placeholder rather than rendering the error body.
        expect(screen.getAllByText('—')).toHaveLength(3);
        expect(screen.queryByText('undefined')).not.toBeInTheDocument();
    });

    it('FaqSection shows an error, not "No FAQs available yet"', async () => {
        stubFetchStatus(status);

        render(<FaqSection />);

        await waitFor(() => expect(screen.getByTestId('faq-error')).toBeInTheDocument());
        expect(screen.getByTestId('faq-error')).toHaveTextContent("Couldn't load FAQs");
        expectNoSuccessCopy();
    });

    it('MyTasks shows an error, not "All caught up"', async () => {
        stubFetchStatus(status);

        render(<MyTasks />);

        await waitFor(() => expect(screen.getByTestId('my-tasks-error')).toBeInTheDocument());
        expect(screen.getByTestId('my-tasks-error')).toHaveTextContent("Couldn't load your tasks");
        expectNoSuccessCopy();
    });
});

describe('dashboard when the request itself fails', () => {
    it('shows error indications on a network error', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
        );

        render(<DashboardPage />);

        await waitFor(() => expect(screen.getByTestId('my-tasks-error')).toBeInTheDocument());
        await waitFor(() => expect(screen.getByTestId('faq-error')).toBeInTheDocument());
        await waitFor(() => expect(screen.getByTestId('stats-error')).toBeInTheDocument());
        expectNoSuccessCopy();
    });
});

describe('dashboard empty states on success', () => {
    it('still says "All caught up" and "No FAQs available yet" when the lists really are empty', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string) => {
                if (url === '/api/dashboard/my-tasks') return Promise.resolve(ok({ tasks: [] }));
                if (url === '/api/dashboard/faq') return Promise.resolve(ok({ entries: [] }));
                return Promise.resolve(ok(statsBody('2026-07', 'July 2026', 12)));
            }),
        );

        render(<DashboardPage />);

        await waitFor(() => expect(screen.getByText('All caught up')).toBeInTheDocument());
        await waitFor(() => expect(screen.getByTestId('faq-empty')).toBeInTheDocument());
        await waitFor(() => expect(screen.getByTestId('trend-total')).toHaveTextContent('12'));
        expect(screen.queryByTestId('my-tasks-error')).not.toBeInTheDocument();
        expect(screen.queryByTestId('faq-error')).not.toBeInTheDocument();
        expect(screen.queryByTestId('stats-error')).not.toBeInTheDocument();
    });
});

describe('dashboard month switch that fails', () => {
    it("clears the previous month's stats and names the month that failed", async () => {
        let juneAttempts = 0;
        const fetchMock = vi.fn((url: string) => {
            if (url === '/api/dashboard/my-tasks') return Promise.resolve(ok({ tasks: [] }));
            if (url === '/api/dashboard/faq') return Promise.resolve(ok({ entries: [] }));
            if (url.includes('month=2026-06')) {
                juneAttempts += 1;
                return Promise.resolve(
                    juneAttempts === 1 ? failure(500) : ok(statsBody('2026-06', 'June 2026', 47)),
                );
            }
            return Promise.resolve(ok(statsBody('2026-07', 'July 2026', 12)));
        });
        vi.stubGlobal('fetch', fetchMock);

        render(<DashboardPage />);
        await waitFor(() => expect(screen.getByTestId('trend-total')).toHaveTextContent('12'));
        expect(screen.getByText('2')).toBeInTheDocument(); // July's SLA breaches

        fireEvent.change(screen.getByLabelText('Select month'), {
            target: { value: '2026-06' },
        });

        await waitFor(() => expect(screen.getByTestId('stats-error')).toBeInTheDocument());
        expect(screen.getByTestId('stats-error')).toHaveTextContent('June 2026');
        // July's numbers must not stay on screen under the June selection.
        expect(screen.queryByTestId('trend-total')).not.toBeInTheDocument();
        expect(screen.queryByText('July 2026')).not.toBeInTheDocument();
        expect(screen.queryByText('2')).not.toBeInTheDocument();
        expect(screen.getAllByText('—')).toHaveLength(3);

        // Retrying re-requests the selected month and recovers.
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(screen.getByTestId('trend-total')).toHaveTextContent('47'));
        expect(screen.queryByTestId('stats-error')).not.toBeInTheDocument();
        expect((screen.getByLabelText('Select month') as HTMLSelectElement).value).toBe('2026-06');
        expect(juneAttempts).toBe(2);
    });
});

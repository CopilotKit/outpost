'use client';

import { useEffect, useState } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { MyTasks } from '@/components/dashboard/my-tasks';
import { SlaHealth } from '@/components/dashboard/sla-health';
import type { SlaMetrics } from '@/components/dashboard/sla-health';
import { TicketsTrend } from '@/components/dashboard/tickets-trend';
import type { TrendDataPoint } from '@/components/dashboard/tickets-trend';
import { FaqSection } from '@/components/dashboard/faq-section';
import { monthLabel } from '@/lib/month-window';

interface StatsResponse {
    slaBreaches: number;
    avgFirstResponseMs: number;
    avgResolutionMs: number;
    totalTickets: number;
    openTickets: number;
    trend: TrendDataPoint[];
    month: string;
    monthKey: string;
    availableMonths: string[];
    year: number;
}

export default function DashboardPage() {
    const [stats, setStats] = useState<StatsResponse | null>(null);
    // null until the first response tells us which month the server picked.
    // Once set, it also drives the dropdown directly, so the operator's choice
    // wins over the last response and the selector never appears to jump back
    // while a slower request is still in flight.
    const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
    // True when the last stats request failed. The stats are cleared at the same time,
    // so a failed month switch never leaves the previous month's numbers on screen
    // under the new selection.
    const [statsFailed, setStatsFailed] = useState(false);
    // Bumped by "Try again" to re-request the selected month.
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        // Switching months twice in quick succession leaves two requests in
        // flight. Without this guard, a slower earlier response can land last
        // and overwrite the newer selection — the chart would show a month the
        // operator already navigated away from, with nothing to correct it.
        let cancelled = false;

        async function fetchStats() {
            function fail() {
                if (cancelled) return;
                setStats(null);
                setStatsFailed(true);
            }

            try {
                const query = selectedMonth ? `?month=${selectedMonth}` : '';
                const res = await fetch(`/api/dashboard/stats${query}`);
                // Any non-OK body is an error, not stats. A 401 shows the error too:
                // SessionGuard redirects to /login on its next session read (mount or
                // window focus); this response does not trigger that.
                if (!res.ok) return fail();
                const data: StatsResponse = await res.json();
                if (cancelled) return;
                setStats(data);
                setStatsFailed(false);
            } catch {
                fail();
            }
        }
        fetchStats();

        return () => {
            cancelled = true;
        };
    }, [selectedMonth, attempt]);

    const slaMetrics: SlaMetrics | undefined = stats
        ? {
              slaBreaches: stats.slaBreaches,
              avgFirstResponseMs: stats.avgFirstResponseMs,
              avgResolutionMs: stats.avgResolutionMs,
          }
        : undefined;

    return (
        <div>
            <PageHeader
                title="Dashboard"
                description="Overview of support operations and key metrics."
                icon={LayoutDashboard}
                breadcrumbs={[{ label: 'Dashboard' }]}
            />

            <div className="space-y-6">
                {/* My Tasks - full width */}
                <MyTasks />

                {/* SLA Health cards */}
                <SlaHealth metrics={slaMetrics} />

                {/* Trend chart and FAQ side by side */}
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                    {statsFailed ? (
                        <div
                            className="rounded-lg border border-border bg-card p-6"
                            data-testid="stats-error"
                        >
                            <h3 className="text-lg font-semibold text-card-foreground">
                                Tickets Trend
                            </h3>
                            <div
                                role="alert"
                                className="mt-4 rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive"
                            >
                                Couldn&apos;t load dashboard stats for{' '}
                                {selectedMonth ? monthLabel(selectedMonth) : 'this month'}.
                            </div>
                            <button
                                type="button"
                                onClick={() => setAttempt((n) => n + 1)}
                                className="mt-4 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
                            >
                                Try again
                            </button>
                        </div>
                    ) : (
                        <TicketsTrend
                            data={stats?.trend ?? []}
                            month={stats?.month ?? ''}
                            monthKey={selectedMonth ?? stats?.monthKey ?? ''}
                            availableMonths={stats?.availableMonths ?? []}
                            onMonthChange={setSelectedMonth}
                            totalTickets={stats?.totalTickets ?? 0}
                        />
                    )}
                    <FaqSection />
                </div>
            </div>
        </div>
    );
}

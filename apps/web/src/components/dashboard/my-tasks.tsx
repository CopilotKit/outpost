'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Filter, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';

interface Task {
    id: string;
    displayId: string;
    title: string;
    status: string;
    priority: string;
    accountName: string | null;
    createdAt: string;
    slaBreachedAt: string | null;
}

const STATUS_COLORS: Record<string, string> = {
    OPEN: 'bg-blue-500/20 text-blue-400',
    IN_PROGRESS: 'bg-yellow-500/20 text-yellow-400',
    WAITING_ON_CUSTOMER: 'bg-purple-500/20 text-purple-400',
    WAITING_ON_TEAM: 'bg-orange-500/20 text-orange-400',
    RESOLVED: 'bg-green-500/20 text-green-400',
    CLOSED: 'bg-gray-500/20 text-gray-400',
};

function formatStatus(status: string): string {
    return status
        .split('_')
        .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
        .join(' ');
}

function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
    });
}

interface MyTasksProps {
    tasks?: Task[];
}

export function MyTasks({ tasks: initialTasks }: MyTasksProps) {
    const [tasks, setTasks] = useState<Task[]>(initialTasks ?? []);
    const [loading, setLoading] = useState(!initialTasks);
    const [loadFailed, setLoadFailed] = useState(false);
    const [filterOpen, setFilterOpen] = useState(false);
    const [statusFilter, setStatusFilter] = useState<string | null>(null);

    useEffect(() => {
        if (initialTasks) return;

        async function fetchTasks() {
            try {
                const res = await fetch('/api/dashboard/my-tasks');
                // Show an error, never the "All caught up" empty state, when the list did not
                // load. A 401 lands here too: SessionGuard redirects to /login on its next
                // session read (mount or window focus); this response does not trigger that.
                if (!res.ok) {
                    setLoadFailed(true);
                    return;
                }
                const data = await res.json();
                setTasks(data.tasks);
            } catch {
                setLoadFailed(true);
            } finally {
                setLoading(false);
            }
        }
        fetchTasks();
    }, [initialTasks]);

    const filteredTasks = statusFilter ? tasks.filter((t) => t.status === statusFilter) : tasks;

    const uniqueStatuses = [...new Set(tasks.map((t) => t.status))];

    return (
        <div className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
                <h2 className="text-lg font-semibold text-card-foreground">My Tasks</h2>
                <div className="relative">
                    <button
                        onClick={() => setFilterOpen(!filterOpen)}
                        className={cn(
                            'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm',
                            'border border-border text-muted-foreground',
                            'hover:bg-muted/50 transition-colors',
                            statusFilter && 'border-primary text-primary',
                        )}
                        aria-label="Filter tasks"
                    >
                        <Filter className="h-4 w-4" />
                        Filter
                    </button>
                    {filterOpen && (
                        <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border border-border bg-card py-1 shadow-lg">
                            <button
                                onClick={() => {
                                    setStatusFilter(null);
                                    setFilterOpen(false);
                                }}
                                className={cn(
                                    'w-full px-3 py-1.5 text-left text-sm',
                                    'hover:bg-muted/50',
                                    !statusFilter && 'text-primary font-medium',
                                )}
                            >
                                All
                            </button>
                            {uniqueStatuses.map((status) => (
                                <button
                                    key={status}
                                    onClick={() => {
                                        setStatusFilter(status);
                                        setFilterOpen(false);
                                    }}
                                    className={cn(
                                        'w-full px-3 py-1.5 text-left text-sm',
                                        'hover:bg-muted/50',
                                        statusFilter === status && 'text-primary font-medium',
                                    )}
                                >
                                    {formatStatus(status)}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {loading ? (
                <div className="px-6 py-8 text-center text-sm text-muted-foreground">
                    Loading tasks...
                </div>
            ) : loadFailed ? (
                <div role="alert" data-testid="my-tasks-error">
                    <EmptyState
                        icon={<AlertTriangle className="h-6 w-6 text-destructive" />}
                        title="Couldn't load your tasks"
                        description="Something went wrong on our side. Reload the page to try again."
                        className="py-8"
                    />
                </div>
            ) : filteredTasks.length === 0 ? (
                <EmptyState
                    icon={<CheckCircle2 className="h-6 w-6 text-green-500" />}
                    title="All caught up"
                    description="No tasks assigned to you. Nice work!"
                    className="py-8"
                />
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead>
                            <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                                <th className="px-6 py-3">Task</th>
                                <th className="px-6 py-3">Status</th>
                                <th className="px-6 py-3">Date</th>
                                <th className="px-6 py-3">Account</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredTasks.map((task) => (
                                <tr
                                    key={task.id}
                                    className="border-b border-border/50 transition-colors hover:bg-muted/30"
                                >
                                    <td className="px-6 py-3">
                                        <div className="flex items-center gap-2">
                                            {task.slaBreachedAt && (
                                                <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                                            )}
                                            <div>
                                                <p className="text-sm font-medium text-card-foreground">
                                                    {task.title}
                                                </p>
                                                <p className="text-xs text-muted-foreground">
                                                    {task.displayId}
                                                </p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-3">
                                        <span
                                            className={cn(
                                                'inline-block rounded-full px-2.5 py-0.5 text-xs font-medium',
                                                STATUS_COLORS[task.status] ??
                                                    'bg-gray-500/20 text-gray-400',
                                            )}
                                        >
                                            {formatStatus(task.status)}
                                        </span>
                                    </td>
                                    <td className="px-6 py-3 text-sm text-muted-foreground">
                                        {formatDate(task.createdAt)}
                                    </td>
                                    <td className="px-6 py-3 text-sm text-muted-foreground">
                                        {task.accountName ?? '—'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

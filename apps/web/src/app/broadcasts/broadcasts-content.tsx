'use client';

import { useState, useCallback, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Megaphone } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { BroadcastList } from '@/components/broadcasts/broadcast-list';
import { BroadcastComposer } from '@/components/broadcasts/broadcast-composer';
import type { Broadcast, BroadcastStatus } from '@/components/broadcasts/broadcast-list';
import type { BroadcastFormData } from '@/components/broadcasts/broadcast-composer';
import type { AccountOption } from '@/components/broadcasts/audience-selector';
import type { TeamMemberOption } from '@/components/broadcasts/sender-picker';
import { apiFetch } from '@/lib/api-fetch';

export default function BroadcastsContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const showComposer = searchParams.get('action') === 'create';

    const [statusFilter, setStatusFilter] = useState<BroadcastStatus | null>(null);
    const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
    const [total, setTotal] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [accounts, setAccounts] = useState<AccountOption[]>([]);
    const [teamMembers, setTeamMembers] = useState<TeamMemberOption[]>([]);
    const [error, setError] = useState<string | null>(null);

    const fetchBroadcasts = useCallback(async (status: BroadcastStatus | null) => {
        setLoading(true);
        setError(null);
        try {
            const url = status
                ? `/api/broadcasts?status=${status}&pageSize=100`
                : '/api/broadcasts?pageSize=100';
            const res = await apiFetch(url);
            if (res.ok) {
                const data = await res.json();
                setBroadcasts(data.broadcasts);
                setTotal(typeof data.total === 'number' ? data.total : null);
            } else {
                const body = await res.json().catch(() => ({}));
                setError(body.error ?? `Failed to fetch broadcasts (${res.status})`);
            }
        } catch {
            setError('Network error fetching broadcasts');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchBroadcasts(statusFilter);
    }, [statusFilter, fetchBroadcasts]);

    // Fetch accounts and team members for the composer
    useEffect(() => {
        async function loadComposerData() {
            const [accountsRes, teamRes] = await Promise.all([
                apiFetch('/api/accounts'),
                apiFetch('/api/team'),
            ]);
            if (accountsRes.ok) {
                const data = await accountsRes.json();
                setAccounts(
                    data.accounts.map((a: { id: string; name: string }) => ({
                        id: a.id,
                        name: a.name,
                    })),
                );
            }
            if (teamRes.ok) {
                const members = await teamRes.json();
                setTeamMembers(
                    members.map((m: { id: string; name: string; email: string }) => ({
                        id: m.id,
                        name: m.name,
                        email: m.email,
                    })),
                );
            }
        }
        loadComposerData().catch(() => {
            setError('Failed to load composer data');
        });
    }, []);

    const openComposer = useCallback(() => {
        router.push('/broadcasts?action=create');
    }, [router]);

    const closeComposer = useCallback(() => {
        router.push('/broadcasts');
    }, [router]);

    const submitBroadcast = useCallback(
        async (data: BroadcastFormData, status: 'DRAFT' | 'SENT') => {
            const senderName =
                teamMembers.find((m) => m.id === data.senderId)?.name || null;

            const body = {
                message: data.message,
                sendAs: senderName,
                audience:
                    data.audienceType === 'all'
                        ? 'ALL_ACCOUNTS'
                        : 'SELECTED_ACCOUNTS',
                targetAccounts:
                    data.audienceType === 'specific'
                        ? data.audienceAccountIds
                        : null,
                status,
            };

            const res = await apiFetch('/api/broadcasts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const errorData = await res.json().catch(() => null);
                setError(errorData?.error ?? `Failed to save broadcast (${res.status})`);
                return;
            }

            setError(null);
            closeComposer();
            fetchBroadcasts(statusFilter);
        },
        [teamMembers, closeComposer, fetchBroadcasts, statusFilter],
    );

    const handleSend = useCallback(
        (data: BroadcastFormData) => {
            submitBroadcast(data, 'SENT').catch((err) => {
                setError(err instanceof Error ? err.message : 'Failed to send broadcast');
            });
        },
        [submitBroadcast],
    );

    const handleSaveDraft = useCallback(
        (data: BroadcastFormData) => {
            submitBroadcast(data, 'DRAFT').catch((err) => {
                setError(err instanceof Error ? err.message : 'Failed to save draft');
            });
        },
        [submitBroadcast],
    );

    return (
        <div>
            <PageHeader
                title="Broadcasts"
                description="Send targeted messages to accounts and user segments."
                icon={Megaphone}
                breadcrumbs={[{ label: 'Broadcasts' }]}
            />

            {error && (
                <div className="mb-4 rounded-md border border-destructive bg-destructive/10 px-4 py-3 text-sm text-destructive" data-testid="broadcast-error">
                    {error}
                </div>
            )}

            {showComposer ? (
                <div className="mb-6 rounded-lg border border-border bg-card p-6">
                    <h2 className="mb-4 text-lg font-semibold text-foreground">
                        New Broadcast
                    </h2>
                    <BroadcastComposer
                        onSend={handleSend}
                        onSaveDraft={handleSaveDraft}
                        onCancel={closeComposer}
                        accounts={accounts}
                        teamMembers={teamMembers}
                    />
                </div>
            ) : (
                <div className="mb-6">
                    <button
                        onClick={openComposer}
                        data-testid="new-broadcast-button"
                        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                    >
                        New Broadcast
                    </button>
                </div>
            )}

            <BroadcastList
                broadcasts={broadcasts}
                onStatusFilter={setStatusFilter}
                activeFilter={statusFilter}
                loading={loading}
            />
            {total !== null && total > broadcasts.length && (
                <p className="mt-4 text-sm text-muted-foreground">
                    Showing {broadcasts.length} of {total} broadcasts. Refine the filter or add
                    pagination to see more.
                </p>
            )}
        </div>
    );
}

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Users, Plus, RefreshCw, Trash2, Shield, UserMinus, Send, KeyRound } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { apiFetch } from '@/lib/api-fetch';

interface TeamMember {
    id: string;
    name: string;
    email: string;
    role: string;
    status: string;
    avatarUrl: string | null;
    invitedAt: string | null;
    joinedAt: string | null;
    createdAt: string;
    hasPassword: boolean;
}

// Same constant and `||` rule as login/page.tsx: a blank build arg must fall back too.
const AUTH_PROVIDER = process.env.NEXT_PUBLIC_AUTH_PROVIDER || 'credentials';

export default function TeamPage() {
    const { data: session, status: sessionStatus } = useSession();
    const router = useRouter();
    const [members, setMembers] = useState<TeamMember[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [resetState, setResetState] = useState<Record<string, 'idle' | 'sending'>>({});

    // Invite modal state
    const [showInviteModal, setShowInviteModal] = useState(false);
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteRole, setInviteRole] = useState('MEMBER');
    const [inviting, setInviting] = useState(false);
    const [inviteError, setInviteError] = useState<string | null>(null);

    const isAdmin = (session?.user as Record<string, unknown> | undefined)?.role === 'ADMIN';

    const fetchMembers = useCallback(async () => {
        try {
            const res = await apiFetch('/api/team');
            if (res.status === 403) {
                router.replace('/dashboard');
                return;
            }
            if (!res.ok) throw new Error('Failed to fetch team members');
            const data = await res.json();
            setMembers(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load team');
        } finally {
            setLoading(false);
        }
    }, [router]);

    useEffect(() => {
        if (sessionStatus === 'loading') return;
        if (!isAdmin) {
            router.replace('/dashboard');
            return;
        }
        fetchMembers();
    }, [sessionStatus, isAdmin, router, fetchMembers]);

    const handleInvite = async (e: React.FormEvent) => {
        e.preventDefault();
        setNotice(null);
        setInviting(true);
        setInviteError(null);

        try {
            const res = await apiFetch('/api/team/invite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
            });
            const data = await res.json();
            if (!res.ok) {
                setInviteError(data.error || 'Failed to send invite');
                setInviting(false);
                return;
            }
            setShowInviteModal(false);
            setInviteEmail('');
            setInviteRole('MEMBER');
            await fetchMembers();
        } catch {
            setInviteError('Failed to send invite');
        } finally {
            setInviting(false);
        }
    };

    const handleChangeRole = async (memberId: string, newRole: string) => {
        setNotice(null);
        await apiFetch(`/api/team/${memberId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: newRole }),
        });
        await fetchMembers();
    };

    const handleToggleStatus = async (memberId: string, currentStatus: string) => {
        setNotice(null);
        const newStatus = currentStatus === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
        await apiFetch(`/api/team/${memberId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus }),
        });
        await fetchMembers();
    };

    const handleRemoveMember = async (memberId: string) => {
        setNotice(null);
        if (!confirm('Are you sure you want to remove this member?')) return;
        await apiFetch(`/api/team/${memberId}`, { method: 'DELETE' });
        await fetchMembers();
    };

    const handleResendInvite = async (memberId: string) => {
        setNotice(null);
        await apiFetch('/api/team/invite/resend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberId }),
        });
    };

    const handleRevokeInvite = async (memberId: string) => {
        setNotice(null);
        await apiFetch(`/api/team/invite/${memberId}`, { method: 'DELETE' });
        await fetchMembers();
    };

    const handleSendReset = async (member: TeamMember) => {
        if (
            !confirm(
                `Send a password reset link to ${member.email}? Their current password keeps working until they use the link.`,
            )
        ) {
            return;
        }
        setError(null);
        setNotice(null);
        setResetState((s) => ({ ...s, [member.id]: 'sending' }));
        try {
            const res = await apiFetch(`/api/team/${member.id}/password-reset`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (res.status === 200 && data.emailSent) {
                setNotice(`Password reset link sent to ${member.email}. It expires in 30 minutes.`);
            } else if (res.status === 200) {
                setError(
                    'The reset link could not be emailed. Check the email settings and try again.',
                );
            } else if (res.status === 429) {
                setError('Too many reset attempts for this member. Try again later.');
            } else if ([400, 404, 409].includes(res.status) && typeof data.error === 'string') {
                setError(data.error);
            } else {
                setError('Something went wrong. Try again.');
            }
        } catch {
            setError('Something went wrong. Try again.');
        } finally {
            setResetState((s) => ({ ...s, [member.id]: 'idle' }));
        }
    };

    if (sessionStatus === 'loading' || loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <div className="text-muted-foreground text-sm">Loading...</div>
            </div>
        );
    }

    const activeMembers = members.filter((m) => m.status !== 'INVITED');
    const pendingInvites = members.filter((m) => m.status === 'INVITED');
    const currentMemberId = (session?.user as Record<string, unknown> | undefined)?.memberId;

    return (
        <div>
            <PageHeader
                title="Team"
                description="Manage team members and invitations."
                icon={Users}
                breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Team' }]}
            />

            {error && (
                <div className="mb-4 rounded-md bg-red-500/10 p-3 text-sm text-red-400">
                    {error}
                </div>
            )}

            {notice && (
                <div className="mb-4 rounded-md bg-green-500/10 p-3 text-sm text-green-400">
                    {notice}
                </div>
            )}

            <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-foreground">Members</h2>
                <button
                    onClick={() => setShowInviteModal(true)}
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                    <Plus className="h-4 w-4" />
                    Invite Member
                </button>
            </div>

            {/* Members table */}
            <div className="rounded-lg border border-border bg-card overflow-hidden mb-8">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-border bg-muted/50">
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                                Name
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                                Email
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                                Role
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                                Status
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                                Joined
                            </th>
                            <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                                Actions
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {activeMembers.map((member) => (
                            <tr key={member.id} className="border-b border-border last:border-0">
                                <td className="px-4 py-3 font-medium text-foreground">
                                    {member.name || '(unnamed)'}
                                </td>
                                <td className="px-4 py-3 text-muted-foreground">{member.email}</td>
                                <td className="px-4 py-3">
                                    <span
                                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                                            member.role === 'ADMIN'
                                                ? 'bg-purple-500/10 text-purple-400'
                                                : 'bg-blue-500/10 text-blue-400'
                                        }`}
                                    >
                                        {member.role}
                                    </span>
                                </td>
                                <td className="px-4 py-3">
                                    <span
                                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                                            member.status === 'ACTIVE'
                                                ? 'bg-green-500/10 text-green-400'
                                                : 'bg-yellow-500/10 text-yellow-400'
                                        }`}
                                    >
                                        {member.status === 'ACTIVE' ? 'Active' : 'Disabled'}
                                    </span>
                                </td>
                                <td className="px-4 py-3 text-muted-foreground">
                                    {member.joinedAt
                                        ? new Date(member.joinedAt).toLocaleDateString()
                                        : new Date(member.createdAt).toLocaleDateString()}
                                </td>
                                <td className="px-4 py-3 text-right">
                                    {member.id !== currentMemberId && (
                                        <div className="flex items-center justify-end gap-1">
                                            {AUTH_PROVIDER === 'credentials' &&
                                                member.status === 'ACTIVE' &&
                                                member.hasPassword && (
                                                    <button
                                                        onClick={() => handleSendReset(member)}
                                                        disabled={
                                                            resetState[member.id] === 'sending'
                                                        }
                                                        title="Send password reset link"
                                                        className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
                                                    >
                                                        {resetState[member.id] === 'sending' ? (
                                                            <RefreshCw className="h-4 w-4 animate-spin" />
                                                        ) : (
                                                            <KeyRound className="h-4 w-4" />
                                                        )}
                                                    </button>
                                                )}
                                            <button
                                                onClick={() =>
                                                    handleChangeRole(
                                                        member.id,
                                                        member.role === 'ADMIN'
                                                            ? 'MEMBER'
                                                            : 'ADMIN',
                                                    )
                                                }
                                                title={
                                                    member.role === 'ADMIN'
                                                        ? 'Demote to Member'
                                                        : 'Promote to Admin'
                                                }
                                                className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                                            >
                                                <Shield className="h-4 w-4" />
                                            </button>
                                            <button
                                                onClick={() =>
                                                    handleToggleStatus(member.id, member.status)
                                                }
                                                title={
                                                    member.status === 'ACTIVE'
                                                        ? 'Disable'
                                                        : 'Enable'
                                                }
                                                className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                                            >
                                                <UserMinus className="h-4 w-4" />
                                            </button>
                                            <button
                                                onClick={() => handleRemoveMember(member.id)}
                                                title="Remove member"
                                                className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </button>
                                        </div>
                                    )}
                                </td>
                            </tr>
                        ))}
                        {activeMembers.length === 0 && (
                            <tr>
                                <td
                                    colSpan={6}
                                    className="px-4 py-8 text-center text-muted-foreground"
                                >
                                    No team members yet.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* Pending invites */}
            {pendingInvites.length > 0 && (
                <>
                    <h2 className="text-lg font-semibold text-foreground mb-4">
                        Pending Invitations
                    </h2>
                    <div className="rounded-lg border border-border bg-card overflow-hidden">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-border bg-muted/50">
                                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                                        Email
                                    </th>
                                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                                        Role
                                    </th>
                                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                                        Invited
                                    </th>
                                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                                        Actions
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {pendingInvites.map((member) => (
                                    <tr
                                        key={member.id}
                                        className="border-b border-border last:border-0"
                                    >
                                        <td className="px-4 py-3 text-foreground">
                                            {member.email}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span
                                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                                                    member.role === 'ADMIN'
                                                        ? 'bg-purple-500/10 text-purple-400'
                                                        : 'bg-blue-500/10 text-blue-400'
                                                }`}
                                            >
                                                {member.role}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-muted-foreground">
                                            {member.invitedAt
                                                ? new Date(member.invitedAt).toLocaleDateString()
                                                : '-'}
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            <div className="flex items-center justify-end gap-1">
                                                <button
                                                    onClick={() => handleResendInvite(member.id)}
                                                    title="Resend invite"
                                                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                                                >
                                                    <Send className="h-3 w-3" />
                                                    Resend
                                                </button>
                                                <button
                                                    onClick={() => handleRevokeInvite(member.id)}
                                                    title="Revoke invite"
                                                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                                                >
                                                    <Trash2 className="h-3 w-3" />
                                                    Revoke
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

            {/* Invite Modal */}
            {showInviteModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                    <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-xl">
                        <h3 className="text-lg font-semibold text-foreground mb-4">
                            Invite Team Member
                        </h3>

                        {inviteError && (
                            <div className="mb-4 rounded-md bg-red-500/10 p-3 text-sm text-red-400">
                                {inviteError}
                            </div>
                        )}

                        <form onSubmit={handleInvite} className="space-y-4">
                            <div>
                                <label
                                    htmlFor="invite-email"
                                    className="block text-sm font-medium text-muted-foreground mb-1"
                                >
                                    Email Address
                                </label>
                                <input
                                    id="invite-email"
                                    type="email"
                                    value={inviteEmail}
                                    onChange={(e) => setInviteEmail(e.target.value)}
                                    required
                                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                                    placeholder="teammate@company.com"
                                />
                            </div>
                            <div>
                                <label
                                    htmlFor="invite-role"
                                    className="block text-sm font-medium text-muted-foreground mb-1"
                                >
                                    Role
                                </label>
                                <select
                                    id="invite-role"
                                    value={inviteRole}
                                    onChange={(e) => setInviteRole(e.target.value)}
                                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                                >
                                    <option value="MEMBER">Member</option>
                                    <option value="ADMIN">Admin</option>
                                </select>
                            </div>
                            <div className="flex gap-3 justify-end pt-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setShowInviteModal(false);
                                        setInviteError(null);
                                    }}
                                    className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={inviting}
                                    className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                                >
                                    {inviting ? (
                                        <>
                                            <RefreshCw className="h-4 w-4 animate-spin" />
                                            Sending...
                                        </>
                                    ) : (
                                        'Send Invite'
                                    )}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}

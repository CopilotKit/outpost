'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { UserCircle, Save } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { apiFetch } from '@/lib/api-fetch';

interface ProfileData {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    role: string;
}

export default function ProfilePage() {
    const router = useRouter();
    const { data: session } = useSession();
    const [profile, setProfile] = useState<ProfileData | null>(null);
    const [name, setName] = useState('');
    const [avatarUrl, setAvatarUrl] = useState('');
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmNewPassword, setConfirmNewPassword] = useState('');
    const [saving, setSaving] = useState(false);
    const [errors, setErrors] = useState<string[]>([]);
    const [success, setSuccess] = useState<string | null>(null);

    const fetchProfile = useCallback(async () => {
        try {
            const res = await apiFetch('/api/profile');
            if (!res.ok) return;
            const data = await res.json();
            setProfile(data);
            setName(data.name);
            setAvatarUrl(data.avatarUrl || '');
        } catch {
            // ignore
        }
    }, []);

    useEffect(() => {
        if (session) fetchProfile();
    }, [session, fetchProfile]);

    const handleSave = async () => {
        setSaving(true);
        setErrors([]);
        setSuccess(null);

        const payload: Record<string, string> = { name, avatarUrl };
        if (currentPassword || newPassword || confirmNewPassword) {
            payload.currentPassword = currentPassword;
            payload.newPassword = newPassword;
            payload.confirmNewPassword = confirmNewPassword;
        }

        try {
            const res = await apiFetch('/api/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (res.status === 401) {
                // The session was revoked (or a concurrent change won): sign in again.
                router.replace('/login');
                return;
            }

            const data = await res.json();

            if (!res.ok) {
                setErrors(data.errors || [data.error || 'Failed to save.']);
                return;
            }

            const changedPassword = Boolean(payload.newPassword);
            setProfile(data);
            setCurrentPassword('');
            setNewPassword('');
            setConfirmNewPassword('');
            if (changedPassword) {
                // Stays on screen: the user needs to know their other devices were signed out.
                setSuccess('Password changed. Your other sessions have been signed out.');
            } else {
                setSuccess('Profile updated successfully.');
                setTimeout(() => setSuccess(null), 3000);
            }
        } catch {
            setErrors(['An unexpected error occurred.']);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div>
            <PageHeader
                title="Profile"
                description="Manage your personal settings."
                icon={UserCircle}
                breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Profile' }]}
            />

            <div className="max-w-lg space-y-6">
                {errors.length > 0 && (
                    <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                        <ul className="list-disc pl-4 space-y-1">
                            {errors.map((err, i) => (
                                <li key={i}>{err}</li>
                            ))}
                        </ul>
                    </div>
                )}

                {success && (
                    <div className="rounded-lg border border-green-500/50 bg-green-500/10 p-3 text-sm text-green-500">
                        {success}
                    </div>
                )}

                {profile && (
                    <div className="space-y-6">
                        {/* Basic info */}
                        <div className="space-y-4">
                            <div>
                                <label
                                    htmlFor="profileName"
                                    className="block text-sm font-medium text-muted-foreground mb-1"
                                >
                                    Name
                                </label>
                                <input
                                    id="profileName"
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                                />
                            </div>
                            <div>
                                <label
                                    htmlFor="profileEmail"
                                    className="block text-sm font-medium text-muted-foreground mb-1"
                                >
                                    Email{' '}
                                    <span className="text-muted-foreground/60">(read-only)</span>
                                </label>
                                <input
                                    id="profileEmail"
                                    type="email"
                                    value={profile.email}
                                    disabled
                                    className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground cursor-not-allowed"
                                />
                            </div>
                            <div>
                                <label
                                    htmlFor="profileAvatarUrl"
                                    className="block text-sm font-medium text-muted-foreground mb-1"
                                >
                                    Avatar URL
                                </label>
                                <input
                                    id="profileAvatarUrl"
                                    type="url"
                                    value={avatarUrl}
                                    onChange={(e) => setAvatarUrl(e.target.value)}
                                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                                    placeholder="https://example.com/avatar.png"
                                />
                            </div>
                        </div>

                        {/* Password change */}
                        <div className="border-t border-border pt-6 space-y-4">
                            <h3 className="text-sm font-semibold text-foreground">
                                Change Password
                            </h3>
                            <div>
                                <label
                                    htmlFor="currentPassword"
                                    className="block text-sm font-medium text-muted-foreground mb-1"
                                >
                                    Current Password
                                </label>
                                <input
                                    id="currentPassword"
                                    type="password"
                                    value={currentPassword}
                                    onChange={(e) => setCurrentPassword(e.target.value)}
                                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                                />
                            </div>
                            <div>
                                <label
                                    htmlFor="newPassword"
                                    className="block text-sm font-medium text-muted-foreground mb-1"
                                >
                                    New Password
                                </label>
                                <input
                                    id="newPassword"
                                    type="password"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    minLength={8}
                                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                                    placeholder="Min 8 characters"
                                />
                            </div>
                            <div>
                                <label
                                    htmlFor="confirmNewPassword"
                                    className="block text-sm font-medium text-muted-foreground mb-1"
                                >
                                    Confirm New Password
                                </label>
                                <input
                                    id="confirmNewPassword"
                                    type="password"
                                    value={confirmNewPassword}
                                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                                />
                            </div>
                        </div>

                        <button
                            onClick={handleSave}
                            disabled={saving}
                            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                        >
                            <Save className="h-4 w-4" />
                            {saving ? 'Saving...' : 'Save Changes'}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

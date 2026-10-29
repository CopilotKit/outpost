'use client';

import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { Mountain, Github, KeyRound, Shield } from 'lucide-react';
import { Suspense, useState, useEffect } from 'react';

// `||` rather than `??` on purpose: this value is inlined at build time, and an unset or
// blank build arg inlines an empty string, which `??` would accept — leaving AUTH_PROVIDER
// as '' and rendering a login card with no sign-in control at all. Empty means "not
// configured", so it must fall through to the default.
//
// This must agree with the server's AUTH_PROVIDER (see src/lib/auth.ts). The two are read
// from different places — this one at build time, the server's at runtime — so a mismatch
// does not fail loudly: it locks users out behind a misleading "Invalid email or password".
const AUTH_PROVIDER = process.env.NEXT_PUBLIC_AUTH_PROVIDER || 'credentials';

function CredentialsForm() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        await signIn('credentials', {
            email,
            password,
            callbackUrl: '/dashboard',
        });
        setLoading(false);
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            <div>
                <label
                    htmlFor="email"
                    className="block text-sm font-medium text-muted-foreground mb-1"
                >
                    Email
                </label>
                <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                    placeholder="you@company.com"
                />
            </div>
            <div>
                <label
                    htmlFor="password"
                    className="block text-sm font-medium text-muted-foreground mb-1"
                >
                    Password
                </label>
                <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                    placeholder="Enter your password"
                />
            </div>
            <div className="text-right">
                <a
                    href={
                        email
                            ? `/forgot-password?email=${encodeURIComponent(email)}`
                            : '/forgot-password'
                    }
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                    Forgot password?
                </a>
            </div>
            <button
                type="submit"
                disabled={loading}
                className="flex w-full items-center justify-center gap-3 rounded-lg bg-foreground px-4 py-3 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
            >
                <KeyRound className="h-5 w-5" />
                {loading ? 'Signing in...' : 'Sign in'}
            </button>
        </form>
    );
}

function GithubButton() {
    return (
        <button
            onClick={() => signIn('github', { callbackUrl: '/dashboard' })}
            className="flex w-full items-center justify-center gap-3 rounded-lg bg-foreground px-4 py-3 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
            <Github className="h-5 w-5" />
            Sign in with GitHub
        </button>
    );
}

function OidcButton() {
    return (
        <button
            onClick={() => signIn('oidc', { callbackUrl: '/dashboard' })}
            className="flex w-full items-center justify-center gap-3 rounded-lg bg-foreground px-4 py-3 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
            <Shield className="h-5 w-5" />
            Sign in with SSO
        </button>
    );
}

function SetupBanner() {
    const [showBanner, setShowBanner] = useState(false);

    useEffect(() => {
        fetch('/api/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
            .then((res) => {
                // 400 means no members exist (validation error, not 403)
                if (res.status !== 403) {
                    setShowBanner(true);
                }
            })
            .catch(() => {});
    }, []);

    if (!showBanner) return null;

    return (
        <a
            href="/setup"
            className="block rounded-lg border border-primary/50 bg-primary/10 p-3 text-center text-sm text-primary hover:bg-primary/20 transition-colors"
        >
            No accounts yet? Set up your admin account &rarr;
        </a>
    );
}

function LoginContent() {
    const searchParams = useSearchParams();
    const error = searchParams.get('error');
    const reset = searchParams.get('reset');

    return (
        <div className="flex min-h-screen items-center justify-center bg-background">
            <div className="w-full max-w-sm space-y-8 px-4">
                <div className="text-center">
                    <div className="flex justify-center">
                        <Mountain className="h-12 w-12 text-primary" />
                    </div>
                    <h1 className="mt-4 text-3xl font-bold text-foreground">Outpost</h1>
                    <p className="mt-2 text-sm text-muted-foreground">
                        AI-Powered Support Operations
                    </p>
                </div>

                <SetupBanner />

                {reset === '1' && (
                    <div className="rounded-lg border border-green-500/50 bg-green-500/10 p-3 text-center text-sm text-green-500">
                        Your password has been reset. Sign in with your new password.
                    </div>
                )}

                {error === 'AccessDenied' && (
                    <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-center text-sm text-destructive">
                        Access denied. You are not authorized to sign in.
                    </div>
                )}

                {error === 'CredentialsSignin' && (
                    <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-center text-sm text-destructive">
                        Invalid email or password. Please try again.
                    </div>
                )}

                {error && error !== 'AccessDenied' && error !== 'CredentialsSignin' && (
                    <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-center text-sm text-destructive">
                        An error occurred during sign in. Please try again.
                    </div>
                )}

                {AUTH_PROVIDER === 'credentials' && <CredentialsForm />}
                {AUTH_PROVIDER === 'github' && <GithubButton />}
                {AUTH_PROVIDER === 'oidc' && <OidcButton />}

                <p className="text-center text-xs text-muted-foreground">
                    {AUTH_PROVIDER === 'credentials' && 'Sign in with your team account.'}
                    {AUTH_PROVIDER === 'github' &&
                        'Team members only. Sign in with your GitHub account.'}
                    {AUTH_PROVIDER === 'oidc' && 'Sign in with your organization SSO.'}
                </p>
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense>
            <LoginContent />
        </Suspense>
    );
}

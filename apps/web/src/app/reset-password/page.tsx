'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mountain } from 'lucide-react';

const EXPIRED = 'This reset link is invalid or has expired.';
const RATE_LIMITED = 'Too many requests. Try again in a few minutes.';
const VERIFY_FAILED = 'We could not check your link. Try again.';

/**
 * 'retry' is a verify that failed for a reason other than the link itself (429, 5xx,
 * any other status, or a network error). The fragment is already gone, so a reload
 * cannot recover; "Try again" re-posts the token held in component state instead.
 */
type Phase = 'checking' | 'ready' | 'expired' | 'retry';

/** Read `#token=…` and remove it from the address bar and history at once. */
function takeTokenFromFragment(): string | null {
    const match = window.location.hash.match(/^#token=([0-9a-f]+)$/);
    window.history.replaceState(null, '', '/reset-password');
    return match ? match[1] : null;
}

function post(url: string, body: unknown) {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function ResetPasswordContent() {
    const router = useRouter();
    // Component state only: never localStorage or sessionStorage.
    const tokenRef = useRef<string | null>(null);
    // `next dev` (StrictMode) runs effects twice; the second run would find the
    // fragment already stripped and show "expired". Run the read exactly once.
    const started = useRef(false);
    const [phase, setPhase] = useState<Phase>('checking');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [errors, setErrors] = useState<string[]>([]);
    const [retryMessage, setRetryMessage] = useState(VERIFY_FAILED);

    // Only a 410 means the link is bad. Anything else may pass on a later try.
    const verify = (token: string) => {
        setPhase('checking');
        post('/api/password-reset/verify', { token })
            .then((res) => {
                if (res.status === 200) {
                    setPhase('ready');
                } else if (res.status === 410) {
                    setPhase('expired');
                } else {
                    setRetryMessage(res.status === 429 ? RATE_LIMITED : VERIFY_FAILED);
                    setPhase('retry');
                }
            })
            .catch(() => {
                setRetryMessage(VERIFY_FAILED);
                setPhase('retry');
            });
    };

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        const token = takeTokenFromFragment();
        tokenRef.current = token;
        if (!token) {
            setPhase('expired');
            return;
        }
        verify(token);
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true);
        setErrors([]);
        try {
            const res = await post('/api/password-reset/confirm', {
                token: tokenRef.current,
                password,
                confirmPassword,
            });
            if (res.status === 200) {
                router.replace('/login?reset=1');
                return;
            }
            if (res.status === 410) {
                setPhase('expired');
                return;
            }
            if (res.status === 429) {
                setErrors([RATE_LIMITED]);
                return;
            }
            const data = await res.json().catch(() => ({}));
            setErrors(
                Array.isArray(data.errors) ? data.errors : ['Something went wrong. Try again.'],
            );
        } catch {
            setErrors(['Something went wrong. Try again.']);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-background">
            <div className="w-full max-w-sm space-y-8 px-4">
                <div className="text-center">
                    <Mountain className="mx-auto h-12 w-12 text-primary" />
                    <h1 className="mt-4 text-2xl font-bold text-foreground">
                        Choose a new password
                    </h1>
                </div>

                {phase === 'checking' && (
                    <p className="text-center text-sm text-muted-foreground">
                        Checking your link...
                    </p>
                )}

                {phase === 'retry' && (
                    <div className="space-y-6 text-center">
                        <p className="text-sm text-destructive">{retryMessage}</p>
                        <button
                            type="button"
                            onClick={() => tokenRef.current && verify(tokenRef.current)}
                            className="inline-block rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 transition-opacity"
                        >
                            Try again
                        </button>
                    </div>
                )}

                {phase === 'expired' && (
                    <div className="space-y-6 text-center">
                        <p className="text-sm text-muted-foreground">{EXPIRED}</p>
                        <a
                            href="/forgot-password"
                            className="inline-block rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 transition-opacity"
                        >
                            Request a new link
                        </a>
                    </div>
                )}

                {phase === 'ready' && (
                    <form onSubmit={handleSubmit} className="space-y-4">
                        {errors.length > 0 && (
                            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                                <ul className="list-disc pl-4 space-y-1">
                                    {errors.map((err) => (
                                        <li key={err}>{err}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        <div>
                            <label
                                htmlFor="password"
                                className="block text-sm font-medium text-muted-foreground mb-1"
                            >
                                New password
                            </label>
                            <input
                                id="password"
                                type="password"
                                autoComplete="new-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                            />
                            <p className="mt-1 text-xs text-muted-foreground">
                                At least 8 characters
                            </p>
                        </div>
                        <div>
                            <label
                                htmlFor="confirmPassword"
                                className="block text-sm font-medium text-muted-foreground mb-1"
                            >
                                Confirm new password
                            </label>
                            <input
                                id="confirmPassword"
                                type="password"
                                autoComplete="new-password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                required
                                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                            />
                        </div>
                        <button
                            type="submit"
                            disabled={submitting}
                            className="flex w-full items-center justify-center rounded-lg bg-foreground px-4 py-3 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                            Set new password
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}

export default function ResetPasswordPage() {
    return (
        <Suspense>
            <ResetPasswordContent />
        </Suspense>
    );
}

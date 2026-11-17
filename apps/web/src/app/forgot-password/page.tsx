'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Mountain } from 'lucide-react';

// The same text for every 200, so the page never reveals whether an account exists.
const NEUTRAL =
    "If an account exists for that address, we've sent a link to reset your password. The link expires in 30 minutes.";

function ForgotPasswordContent() {
    const searchParams = useSearchParams();
    const [email, setEmail] = useState(searchParams.get('email') ?? '');
    const [submitting, setSubmitting] = useState(false);
    const [sent, setSent] = useState(false);
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true);
        setFieldError(null);
        setError(null);
        try {
            // Plain fetch: this path is public and skips CSRF (like invite accept).
            const res = await fetch('/api/password-reset/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            });
            if (res.status === 200) {
                setSent(true);
            } else if (res.status === 400) {
                const data = await res.json().catch(() => ({}));
                setFieldError(
                    typeof data.error === 'string' ? data.error : 'Enter a valid email address.',
                );
            } else if (res.status === 429) {
                setError('Too many requests. Try again in a few minutes.');
            } else {
                setError('Something went wrong. Try again.');
            }
        } catch {
            setError('Something went wrong. Try again.');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-background">
            <div className="w-full max-w-sm space-y-8 px-4">
                <div className="text-center">
                    <Mountain className="mx-auto h-12 w-12 text-primary" />
                    <h1 className="mt-4 text-2xl font-bold text-foreground">Reset your password</h1>
                </div>

                {sent ? (
                    <div className="space-y-6 text-center">
                        <p className="text-sm text-muted-foreground">{NEUTRAL}</p>
                        <a href="/login" className="text-sm text-primary hover:underline">
                            Back to sign in
                        </a>
                    </div>
                ) : (
                    <form onSubmit={handleSubmit} className="space-y-4">
                        {error && (
                            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                                {error}
                            </div>
                        )}
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
                                aria-invalid={fieldError ? true : undefined}
                                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                                placeholder="you@company.com"
                            />
                            {fieldError && (
                                <p className="mt-1 text-xs text-destructive">{fieldError}</p>
                            )}
                        </div>
                        <button
                            type="submit"
                            disabled={submitting}
                            className="flex w-full items-center justify-center rounded-lg bg-foreground px-4 py-3 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                            Send reset link
                        </button>
                        <p className="text-center text-xs">
                            <a
                                href="/login"
                                className="text-muted-foreground hover:text-foreground"
                            >
                                Back to sign in
                            </a>
                        </p>
                    </form>
                )}
            </div>
        </div>
    );
}

export default function ForgotPasswordPage() {
    return (
        <Suspense>
            <ForgotPasswordContent />
        </Suspense>
    );
}

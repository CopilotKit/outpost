import { NextResponse } from 'next/server';
import { authProvider } from '@/lib/auth-provider';

/** One message for unknown, used, expired, and stale links, so nothing distinguishes them. */
export const INVALID_RESET_LINK = 'This reset link is invalid or has expired.';

/** application/json, any case, alone or followed by parameters. */
const JSON_MEDIA_TYPE = /^application\/json\s*(;|$)/i;

/**
 * Shared front door for the public /api/password-reset/* routes.
 * - 404 unless AUTH_PROVIDER is credentials (the identity provider owns passwords otherwise).
 * - 415 unless the body is JSON. JSON forces a CORS preflight on a cross-origin
 *   post, which blocks a drive-by form post now that these paths skip CSRF.
 *   The media type must be exactly application/json (any case), optionally
 *   followed by parameters: not application/json-patch+json, and not a
 *   CORS-simple text/plain that only mentions application/json in a parameter.
 */
export function guardPublicResetRoute(request: Request): NextResponse | null {
    if (authProvider() !== 'credentials') {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const contentType = request.headers.get('content-type') ?? '';
    if (!JSON_MEDIA_TYPE.test(contentType)) {
        return NextResponse.json(
            { error: 'Content-Type must be application/json.' },
            { status: 415 },
        );
    }
    return null;
}

/** The parsed JSON body as an object, or {} for anything else. Never throws. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
    try {
        const body: unknown = await request.json();
        return body && typeof body === 'object' && !Array.isArray(body)
            ? (body as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

export function resetServerError(route: string, err: unknown): NextResponse {
    console.error(
        `[PASSWORD_RESET] ${route} failed error=${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
}

export function tooManyRequests(): NextResponse {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 });
}

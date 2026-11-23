/**
 * The credential for GitHub reads: a GitHub App installation token, minted per run.
 *
 * The bot used to read with a personal token in `GITHUB_TOKEN`. That token
 * expired, and every release source failed with 401 until someone noticed. An
 * installation token is minted from the App's private key on each run and lasts
 * an hour, so there is nothing to expire between runs.
 *
 * It is the same App the github-app service runs as, with the same three
 * variables. It asks for `metadata: read` only, the one permission it needs:
 * every repository this bot reads is public, and GitHub serves releases and
 * compares of a public repository to any token. It must not ask for
 * `contents: read`, which the App does not hold - GitHub refuses the whole
 * exchange with a 422 rather than narrowing it. `ag-ui-protocol/ag-ui` is in
 * another org with no installation, and is readable with this token all the
 * same.
 *
 * `GITHUB_TOKEN` still works when the App variables are absent, for local runs.
 */

import { createSign } from 'node:crypto';
import { TIMEOUT_MS, parseJson } from './http.js';

const API = 'https://api.github.com';

const APP_VARIABLES = ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID'] as const;

/**
 * Re-mint this long before GitHub's expiry. A token issued for an hour outlives
 * the 20-minute run budget, so in practice one token serves the whole run; the
 * margin covers a run that overruns its budget finishing the release in flight.
 */
const REFRESH_MARGIN_MS = 5 * 60_000;

let cached: { token: string; expiresAt: number } | undefined;

/** Forget the cached token. For tests. */
export function resetGitHubAuth() {
    cached = undefined;
}

const base64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

/**
 * The App's JWT, RS256-signed, as GitHub specifies: issued a minute in the past
 * to absorb clock drift, expiring well inside GitHub's 10-minute ceiling.
 */
export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
    const seconds = Math.floor(now / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(
        JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }),
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    // A key pasted into a single-line variable arrives with literal `\n`.
    const pem = privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey;
    return `${header}.${payload}.${signer.sign(pem).toString('base64url')}`;
}

async function mint(appId: string, privateKey: string, installationId: string) {
    const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'copilotkit-release-bot',
            Authorization: `Bearer ${appJwt(appId, privateKey)}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ permissions: { metadata: 'read' } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        // The body is GitHub's error message, never the token: there is none on
        // a failed exchange.
        throw new Error(
            `GitHub ${res.status} minting an installation token: ${(await res.text()).slice(0, 200)}`,
        );
    }
    const body = await parseJson<{ token?: string; expires_at?: string }>(res, 'GitHub');
    if (!body.token || !body.expires_at) {
        throw new Error('GitHub returned an installation token response without a token.');
    }
    return { token: body.token, expiresAt: Date.parse(body.expires_at) };
}

/**
 * The bearer token for a GitHub read.
 *
 * Throws `<NAME> is not set` for a missing credential, which index.ts treats as
 * a misconfiguration that stops the run rather than one source. Setting some of
 * the App variables and not others is reported the same way, naming the first
 * one missing, rather than quietly falling back to `GITHUB_TOKEN`.
 */
export async function githubToken(): Promise<string> {
    const values = APP_VARIABLES.map((name) => process.env[name]?.trim() || undefined);

    if (values.every((value) => value === undefined)) {
        const token = process.env.GITHUB_TOKEN;
        if (!token) {
            throw new Error(
                'GITHUB_APP_ID is not set, and neither is GITHUB_TOKEN. Set the App variables ' +
                    '(GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_INSTALLATION_ID).',
            );
        }
        return token;
    }

    const missing = APP_VARIABLES.find((_, i) => values[i] === undefined);
    if (missing)
        throw new Error(`${missing} is not set, though the other GitHub App variables are.`);

    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token;

    const [appId, privateKey, installationId] = values as [string, string, string];
    cached = await mint(appId, privateKey, installationId);
    return cached.token;
}

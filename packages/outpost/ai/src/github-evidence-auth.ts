/**
 * Authentication for the support agent's read-only GitHub evidence requests.
 *
 * `read_source` and `read_release` were the only GitHub callers in this package
 * that sent no credential at all, so they ran on the anonymous 60 requests/hour
 * budget shared by every process on the host while the worker already holds App
 * installation credentials. This module reuses those same credentials —
 * `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` / `GITHUB_INSTALLATION_ID`, read exactly
 * as `shared/platforms/registry.ts` and `apps/github-app` read them — and nothing
 * else: no `gh` CLI token, no personal access token, no key file on disk.
 */

import { createAppAuth } from '@octokit/auth-app';

/**
 * Evidence reads fetch commits, file contents and release metadata. `contents:read`
 * covers all three; `metadata:read` is implicit in every installation token. Asking
 * for a narrowed token means a leaked one cannot write, and cannot read anything the
 * App is installed for beyond repository contents.
 */
const EVIDENCE_PERMISSIONS = { contents: 'read' } as const;

/** Installation ids are positive decimal integers; `Number` alone would accept `1e3` and ` 7 `. */
const INSTALLATION_ID = /^[1-9][0-9]*$/;

export class GitHubEvidenceAuthError extends Error {
    override name = 'GitHubEvidenceAuthError';
}

/**
 * Resolves the `Authorization` header value for one evidence request.
 *
 * `undefined` means "send no Authorization header" — the anonymous public-repository
 * path, which is reachable only when no App credential is configured at all. A
 * configured-but-unusable credential must reject here: resolving to `undefined`
 * instead would turn a misconfiguration into a quietly rate-limited success.
 */
export interface GitHubEvidenceAuth {
    authorization(): Promise<string | undefined>;
}

/** Unauthenticated public reads, for development hosts with no App credentials. */
export const anonymousGitHubEvidenceAuth: GitHubEvidenceAuth = {
    authorization: async () => undefined,
};

/**
 * The slice of `createAppAuth` this module uses, named so tests can substitute it.
 * Injecting here rather than stubbing the module keeps the production path — env
 * variables through `createAppAuth` — the one every pipeline consumer gets by default.
 */
export type InstallationTokenFactory = (credentials: {
    appId: string;
    privateKey: string;
    installationId: number;
}) => (options: {
    type: 'installation';
    installationId: number;
    permissions: Record<string, string>;
}) => Promise<{ token: string }>;

/**
 * Build the evidence credential from the worker's configured App environment.
 *
 * Classification happens eagerly — it is a pure read of three strings — but the
 * strategy itself is built on first use, so constructing a `SupportAgent` for a run
 * that never reads GitHub signs no JWT. A partial or malformed configuration yields a
 * resolver that rejects when invoked rather than one that throws at construction:
 * the agent is built for every ticket, and a misconfigured host should fail the
 * evidence request it actually attempted, not every unrelated investigation.
 */
export function githubEvidenceAuthFromEnv(
    env: Record<string, string | undefined> = process.env,
    createAuth: InstallationTokenFactory = createAppAuth as unknown as InstallationTokenFactory,
): GitHubEvidenceAuth {
    const appId = env.GITHUB_APP_ID?.trim() ?? '';
    const privateKey = env.GITHUB_PRIVATE_KEY?.trim() ?? '';
    const installationId = env.GITHUB_INSTALLATION_ID?.trim() ?? '';

    const missing = (
        [
            ['GITHUB_APP_ID', appId],
            ['GITHUB_PRIVATE_KEY', privateKey],
            ['GITHUB_INSTALLATION_ID', installationId],
        ] as const
    )
        .filter(([, value]) => !value)
        .map(([name]) => name);

    if (missing.length === 3) return anonymousGitHubEvidenceAuth;
    if (missing.length)
        return rejecting(
            `GitHub evidence authentication is partially configured; missing ${missing.join(', ')}`,
        );
    if (!INSTALLATION_ID.test(installationId))
        return rejecting(
            'GitHub evidence authentication requires GITHUB_INSTALLATION_ID to be a positive integer',
        );

    return installationAuth(
        { appId, privateKey, installationId: Number(installationId) },
        createAuth,
    );
}

/** Mints installation tokens for evidence requests, deferring every cache decision to the SDK. */
function installationAuth(
    credentials: { appId: string; privateKey: string; installationId: number },
    createAuth: InstallationTokenFactory,
): GitHubEvidenceAuth {
    let auth: ReturnType<InstallationTokenFactory> | undefined;
    return {
        async authorization() {
            auth ??= createAuth(credentials);
            // Called per request on purpose. @octokit/auth-app caches the installation
            // token and re-mints it before the one-hour expiry; holding the string here
            // would pin a bearer that stops working an hour into the worker's uptime.
            const { token } = await (
                auth({
                    type: 'installation',
                    installationId: credentials.installationId,
                    permissions: EVIDENCE_PERMISSIONS,
                }) as Promise<{ token: string }>
            ).catch(rethrowWithoutCredentials);
            return `Bearer ${token}`;
        },
    };
}

function rejecting(reason: string): GitHubEvidenceAuth {
    return {
        authorization: async () => {
            throw new GitHubEvidenceAuthError(reason);
        },
    };
}

/**
 * A JWT-signing or token-exchange failure can quote the PEM it rejected or the token
 * it just minted, and this error travels to worker logs and run reports. Only the
 * underlying error's class name crosses the boundary — deliberately not its message,
 * and not as `cause`, which any structured logger would serialize straight back out.
 */
function rethrowWithoutCredentials(caught: unknown): never {
    const kind = caught instanceof Error ? caught.name : typeof caught;
    throw new GitHubEvidenceAuthError(
        `GitHub App installation token request for evidence failed (${kind})`,
    );
}

/**
 * The single place an evidence request's headers are assembled, so no caller can
 * reach `api.github.com` with an `Authorization` header this module did not mint.
 */
export async function githubEvidenceHeaders(
    auth: GitHubEvidenceAuth,
): Promise<Record<string, string>> {
    const authorization = await auth.authorization();
    return {
        Accept: 'application/vnd.github+json',
        ...(authorization ? { Authorization: authorization } : {}),
    };
}

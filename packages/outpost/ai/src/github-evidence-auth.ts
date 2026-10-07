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
import { Octokit } from '@octokit/rest';

/**
 * Evidence reads fetch commits, file contents and release metadata. `contents:read`
 * covers all three; `metadata:read` is implicit in every installation token. Asking
 * for a narrowed token means a leaked one cannot write, and cannot read anything the
 * App is installed for beyond repository contents.
 */
const EVIDENCE_PERMISSIONS = { contents: 'read' } as const;

/** Installation ids are positive decimal integers; `Number` alone would accept `1e3` and ` 7 `. */
const INSTALLATION_ID = /^[1-9][0-9]*$/;

/**
 * Ceiling on a single installation-token exchange with GitHub.
 *
 * Fixed, rather than inherited from whichever investigation happened to ask first:
 * `@octokit/auth-app` serves every concurrent caller with the same installation and
 * permissions from one shared in-flight request, so a per-investigation deadline would
 * let the first investigation to give up cancel the token the others are waiting on.
 * A bound is still required, because an exchange with no deadline can hang forever and
 * the SDK hands that same stalled promise to every later caller.
 */
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

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
    /**
     * `signal` is the calling investigation's deadline. It bounds how long *this caller*
     * waits, and must not be handed to a credential exchange shared with other
     * investigations. An already-aborted signal must do no credential work at all.
     */
    authorization(signal?: AbortSignal): Promise<string | undefined>;
}

/** Unauthenticated public reads, for development hosts with no App credentials. */
export const anonymousGitHubEvidenceAuth: GitHubEvidenceAuth = {
    authorization: async () => undefined,
};

export interface InstallationCredentials {
    appId: string;
    privateKey: string;
    installationId: number;
}

/** Mints one installation token. The slice of the App strategy's `auth()` this module calls. */
export type InstallationTokenSource = (options: {
    type: 'installation';
    installationId: number;
    permissions: Record<string, string>;
}) => Promise<{ token: string }>;

/**
 * Builds a token source from credentials, named so tests can substitute it. Injecting
 * here rather than stubbing the module keeps the production path — env variables through
 * `createAppAuth` — the one every pipeline consumer gets by default.
 */
export type InstallationTokenFactory = (
    credentials: InstallationCredentials,
) => InstallationTokenSource;

/**
 * The production factory: `createAppAuth`, wired to a request that cannot hang.
 *
 * `request` is the only seam the strategy exposes — `auth()` forwards no per-call request
 * — and `@octokit/request` reads its `fetch` from there, so this wrapper is the only
 * place a deadline can be applied. It must be minted per attempt: a single
 * `AbortSignal.timeout` baked into the request defaults would fire once and then reject
 * every later exchange for the lifetime of the worker.
 *
 * Adapting rather than passing `createAppAuth` directly is what lets both sides keep
 * their real types; the overloaded `AuthInterface` is not structurally assignable to the
 * one narrow call signature this module needs.
 */
export const appInstallationTokens: InstallationTokenFactory = (credentials) => {
    const auth = createAppAuth({
        ...credentials,
        request: new Octokit({
            request: {
                fetch: (url: string | URL | Request, init?: RequestInit) => {
                    const deadline = AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS);
                    return fetch(url, {
                        ...init,
                        signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
                    });
                },
            },
        }).request,
    });
    return (options) => auth(options);
};

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
    createAuth: InstallationTokenFactory = appInstallationTokens,
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
    credentials: InstallationCredentials,
    createAuth: InstallationTokenFactory,
): GitHubEvidenceAuth {
    let tokens: InstallationTokenSource | undefined;
    return {
        async authorization(signal) {
            // Ahead of any credential work: an investigation that has already run out of
            // time must not sign a JWT or open an exchange whose result nothing will read.
            signal?.throwIfAborted();
            const { token } = await mintWithoutLeaking(() => {
                // Built on first use, and inside the boundary: createAppAuth validates its
                // options synchronously and names what it rejected, so a throw here could
                // quote the PEM exactly as a failed exchange could.
                tokens ??= createAuth(credentials);
                // Re-invoked per request on purpose. @octokit/auth-app caches the
                // installation token and re-mints it before the one-hour expiry; holding
                // the string here would pin a bearer that stops working an hour into the
                // worker's uptime.
                return tokens({
                    type: 'installation',
                    installationId: credentials.installationId,
                    permissions: EVIDENCE_PERMISSIONS,
                });
            });
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
 * Runs strategy construction and the token exchange inside one boundary.
 *
 * Either step can quote the PEM it rejected or the token it just minted, and this error
 * travels to worker logs and run reports. Only the underlying error's class name crosses
 * the boundary — deliberately not its message, and not as `cause`, which any structured
 * logger would serialize straight back out.
 */
async function mintWithoutLeaking(
    mint: () => Promise<{ token: string }>,
): Promise<{ token: string }> {
    try {
        return await mint();
    } catch (caught) {
        const kind = caught instanceof Error ? caught.name : typeof caught;
        throw new GitHubEvidenceAuthError(
            `GitHub App installation token request for evidence failed (${kind})`,
        );
    }
}

/**
 * Resolves with `pending`, or rejects the moment `signal` aborts — whichever comes first.
 *
 * The exchange behind `pending` is deliberately left running rather than cancelled:
 * `@octokit/auth-app` shares one in-flight token request between concurrent callers, so
 * cancelling on behalf of a single abandoned investigation would reject the others too.
 * Detaching lets it finish and fill the SDK cache for whoever is still waiting.
 *
 * The rejection is the signal's own reason, which makes a cancelled authorization
 * indistinguishable from the cancelled fetch it was about to authorize: terminal, and
 * never a `GitHubEvidenceAuthError` a caller could mistake for a retryable auth failure.
 */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return pending;
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        // An abort that landed while the exchange was being opened fires no event of its
        // own, so the current state has to be read as well as subscribed to.
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        // Settling either way drops the listener: a resolver that outlives one
        // investigation must not accumulate one listener per evidence request. Attaching
        // handlers to `pending` also keeps a late rejection from going unhandled once the
        // race has already been lost to the abort.
        void pending
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort));
    });
}

/**
 * The single place an evidence request's headers are assembled, so no caller can
 * reach `api.github.com` with an `Authorization` header this module did not mint.
 *
 * `signal` bounds the authorization itself, not just the request it authorizes. Awaiting
 * an unbounded credential exchange here would let a stalled token request outlive the
 * deadline the investigation set, however short that deadline was.
 */
export async function githubEvidenceHeaders(
    auth: GitHubEvidenceAuth,
    signal?: AbortSignal,
): Promise<Record<string, string>> {
    signal?.throwIfAborted();
    const authorization = await untilAborted(auth.authorization(signal), signal);
    return {
        Accept: 'application/vnd.github+json',
        ...(authorization ? { Authorization: authorization } : {}),
    };
}

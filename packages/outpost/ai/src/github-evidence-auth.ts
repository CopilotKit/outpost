/**
 * Authentication for the support agent's read-only GitHub evidence requests.
 *
 * `read_source` and `read_release` were the only GitHub callers in this package
 * that sent no credential at all, so they ran on the anonymous 60 requests/hour
 * budget shared by every process on the host while the worker already holds App
 * installation credentials. This module reuses those same credentials — the
 * `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` / `GITHUB_INSTALLATION_ID` variables that
 * `shared/platforms/registry.ts` and `apps/github-app` read, though not read the same
 * way: both of those take the raw values (the registry converting the id with `Number`),
 * while this module trims each one and accepts only a positive decimal installation id.
 * It reads nothing else: no `gh` CLI token, no personal access token, no key file on disk.
 */

import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

/**
 * Evidence reads fetch commits, file contents and release metadata, and only from the two
 * public repositories `support-agent.ts` allowlists. GitHub serves all three for a public
 * repository to any token, whatever its permissions, so the token asks for nothing beyond
 * `metadata:read`, which the App already holds. It must not ask for `contents:read`: the App
 * is not granted it, and GitHub refuses the whole exchange with a 422 rather than narrowing.
 * The App is deliberately not granted it either: it is installed on every org repository,
 * private ones included, and reads untrusted issue text.
 */
const EVIDENCE_PERMISSIONS = { metadata: 'read' } as const;

/**
 * The token is narrowed to the one allowlisted repository this installation covers, so a
 * leaked one cannot even list metadata of the org's other repositories. `ag-ui-protocol/ag-ui`
 * belongs to another org and cannot be named here; as a public repository it is readable with
 * this token all the same.
 */
const EVIDENCE_REPOSITORIES: readonly string[] = ['CopilotKit'];

/**
 * Installation ids are positive decimal integers; `Number` alone would accept `1e3` and `0x1f`.
 * It is tested after trimming, so surrounding whitespace is accepted.
 */
const INSTALLATION_ID = /^[1-9][0-9]*$/;

/**
 * A minted token rides as `Bearer <token>`, so it must be one unbroken run of visible ASCII
 * other than `|`. Anything else is a malformed exchange rather than a credential: an empty
 * token authenticates nothing, `fetch` refuses outright a header value with a line break in
 * it, and a space or tab inside it leaves a header that is no longer a scheme and one token.
 *
 * `|` is excluded because the SDK cannot store it: `@octokit/auth-app@7.2.2` caches a token
 * as one `|`-joined string and splits it on `|` when read back (`dist-node/index.js:89-96`
 * `set`, `:57-64` `get`), so a cached `ghs_a|b` returns as the bearer `ghs_a`.
 */
const INSTALLATION_TOKEN = /^[\x21-\x7B\x7D\x7E]+$/;

/**
 * An `Authorization` value an evidence request may carry: a scheme, one space, and a credential
 * of visible ASCII. Whitespace alone, or a scheme with nothing after it, is a credential the
 * resolver failed to produce, not one GitHub could check.
 */
const AUTHORIZATION_VALUE = /^[A-Za-z]+ [\x21-\x7E]+$/;

/**
 * How long GitHub may refuse an installation token it has just issued, while the token
 * replicates. Re-minting inside the window would only trade one unreplicated token for another.
 *
 * The five seconds are `@octokit/auth-app@7.2.2`'s, but not its measurement. Its request hook,
 * which this module does not use, takes a token's age as it sends each attempt
 * (`dist-node/index.js:400`, before the request at `:402`), retries a 401 to an attempt sent
 * younger than this (`:413-419`), and gives up on one sent at this age or older (`:337`
 * `FIVE_SECONDS_IN_MS`, `:407-412`). This resolver retries nothing, and takes the age when a 401
 * is reported to `invalidate`, after the round trip. A token can therefore look older here than
 * auth-app would judge it, by up to the refused request's latency: a request sent at 4.9 s whose
 * 401 arrives at 5.1 s retires the token here, where auth-app would retry it. The cost is one
 * exchange, for a replacement that has itself only just been issued.
 */
const TOKEN_REPLICATION_LAG_MS = 5_000;

/** The only configuration names this module reads, and the only ones it will ever name. */
const EVIDENCE_VARIABLES = [
    'GITHUB_APP_ID',
    'GITHUB_PRIVATE_KEY',
    'GITHUB_INSTALLATION_ID',
] as const;
type EvidenceVariable = (typeof EVIDENCE_VARIABLES)[number];

/**
 * The closed vocabulary an operator-facing log line may use.
 *
 * Every value is a compile-time constant of this module: no credential, no response body and
 * no third-party error text can become one. `auth_unavailable` is the fallback for a failure
 * this module did not classify — including one raised through the `githubAuth` injection seam,
 * which can hand a caller a `GitHubEvidenceAuthError` carrying anything at all.
 */
export type GitHubEvidenceAuthCode =
    | 'partial_configuration'
    | 'invalid_installation_id'
    | 'token_exchange_failed'
    | 'auth_unavailable';

export interface GitHubEvidenceAuthDiagnostic {
    readonly code: GitHubEvidenceAuthCode;
    /** Present only for `partial_configuration`, and only ever a subset of `EVIDENCE_VARIABLES`. */
    readonly missing?: readonly EvidenceVariable[];
}

/** The codes this module itself raises; anything else degrades to `auth_unavailable`. */
const CLASSIFIED: ReadonlySet<string> = new Set<GitHubEvidenceAuthCode>([
    'partial_configuration',
    'invalid_installation_id',
    'token_exchange_failed',
]);

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
    /**
     * A claim about what went wrong, not a trusted one. `message` stays unreadable to any
     * consumer — it can carry a third-party error's class name, and an error raised through
     * the `githubAuth` seam can carry anything — so this is the only part meant to be surfaced,
     * and only after `githubEvidenceAuthDiagnostic` has re-derived it from the allowlists above.
     */
    readonly diagnostic?: GitHubEvidenceAuthDiagnostic;

    constructor(message: string, diagnostic?: GitHubEvidenceAuthDiagnostic) {
        super(message);
        this.diagnostic = diagnostic;
    }
}

/**
 * Reduces any authorization failure to a category safe to write to the worker log.
 *
 * Nothing is forwarded: the returned code is matched against `CLASSIFIED` and the returned
 * variable names are rebuilt from `EVIDENCE_VARIABLES`, so a forged or unclassified diagnostic
 * yields the bare `auth_unavailable` rather than whatever it was carrying.
 */
export function githubEvidenceAuthDiagnostic(error: unknown): GitHubEvidenceAuthDiagnostic {
    const claimed = error instanceof GitHubEvidenceAuthError ? error.diagnostic : undefined;
    if (!claimed) return { code: 'auth_unavailable' };
    // Each claimed field is read exactly once. The diagnostic is a plain object its author
    // owns, so a property may be a getter: re-reading it would let a value the allowlist
    // never saw be the one returned, and would make a shape the type guard accepted differ
    // from the one used.
    const code = claimed.code;
    const claimedMissing: unknown = claimed.missing;
    if (!CLASSIFIED.has(code)) return { code: 'auth_unavailable' };
    if (code !== 'partial_configuration') return { code };
    const names: readonly unknown[] = Array.isArray(claimedMissing) ? claimedMissing : [];
    const missing = EVIDENCE_VARIABLES.filter((name) => names.includes(name));
    // A partial configuration that names none of the three is not one this module raised.
    return missing.length ? { code, missing } : { code: 'auth_unavailable' };
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
    /**
     * Reports that GitHub answered 401 to a request carrying `refusedAuthorization`, the exact
     * `Authorization` value this resolver handed out for it. Absent where there is nothing to
     * retire: anonymous and misconfigured resolvers hold no credential.
     *
     * The report is evidence, not an order. A resolver may ignore one that names a bearer it
     * has already replaced, or one GitHub may still be replicating; once it acts, it must not
     * hand `refusedAuthorization` to any caller again, including one whose `authorization()`
     * was already under way when the refusal landed.
     */
    invalidate?(refusedAuthorization: string): void;
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

/**
 * Mints one installation token, or reads it back from the strategy's cache. The slice of the
 * App strategy's `auth()` this module calls.
 *
 * `token` and `createdAt` are typed as what actually arrives, not as the SDK declares them.
 * `@octokit/auth-app@7.2.2` destructures `token` from whatever body a 2xx exchange carried and
 * returns it without checking (`dist-node/index.js:229-241`, `:273`), so it can be absent.
 * `createdAt` is the SDK's own clock reading at the exchange (`:246`); GitHub's response has no
 * such field (`@octokit/openapi-types@25.1.0` `types.d.ts:11881-11899`, `installation-token`),
 * and other sources need not report one.
 */
export type InstallationTokenSource = (options: {
    type: 'installation';
    installationId: number;
    permissions: Record<string, string>;
    /** Repository names, within the installation's owner, the token is narrowed to. */
    repositoryNames?: string[];
    /**
     * Skip the strategy's cache and exchange again (`dist-node/index.js:182`). A call that
     * overlaps another for the same installation and permissions still shares that call's
     * promise, refresh or not (`:167-180`).
     */
    refresh?: boolean;
}) => Promise<{ token?: string; createdAt?: string }>;

/**
 * Builds a token source from credentials, named so tests can substitute it. Injecting
 * here rather than stubbing the module keeps the production path — env variables through
 * `createAppAuth` — the one every pipeline consumer gets by default.
 *
 * A source that caches must honor `refresh`: it is how the resolver retires a token GitHub
 * refused. A source that ignores it can only fail those reads, never serve the refused bearer.
 */
export type InstallationTokenFactory = (
    credentials: InstallationCredentials,
) => InstallationTokenSource;

/**
 * The production factory: `createAppAuth`, wired to a request that cannot hang.
 *
 * `request` is the only seam the strategy exposes — `auth()` forwards no per-call request
 * (`@octokit/auth-app@7.2.2` `dist-node/index.js:283-288`, `:160`) — and `@octokit/request`
 * reads its `fetch` from there (`@octokit/request@9.2.4` `dist-bundle/index.js:33`), so this
 * wrapper is the only place a deadline can be applied. It must be minted per attempt: a single
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
 *
 * A usable configuration resolves to one resolver shared across the process (see
 * `sharedInstallationAuth`), so the token one investigation mints is the one the
 * next investigation reuses.
 */
export function githubEvidenceAuthFromEnv(
    env: Record<string, string | undefined> = process.env,
    createAuth: InstallationTokenFactory = appInstallationTokens,
): GitHubEvidenceAuth {
    const appId = env.GITHUB_APP_ID?.trim() ?? '';
    const privateKey = env.GITHUB_PRIVATE_KEY?.trim() ?? '';
    const installationId = env.GITHUB_INSTALLATION_ID?.trim() ?? '';

    // Keyed by the same allowlist the diagnostic is rebuilt from, so a name can never be
    // reported missing that `githubEvidenceAuthDiagnostic` would then drop as unrecognized.
    const configured: Record<EvidenceVariable, string> = {
        GITHUB_APP_ID: appId,
        GITHUB_PRIVATE_KEY: privateKey,
        GITHUB_INSTALLATION_ID: installationId,
    };
    const missing = EVIDENCE_VARIABLES.filter((name) => !configured[name]);

    if (missing.length === EVIDENCE_VARIABLES.length) return anonymousGitHubEvidenceAuth;
    if (missing.length)
        return rejecting(
            `GitHub evidence authentication is partially configured; missing ${missing.join(', ')}`,
            { code: 'partial_configuration', missing },
        );
    if (!INSTALLATION_ID.test(installationId))
        return rejecting(
            'GitHub evidence authentication requires GITHUB_INSTALLATION_ID to be a positive integer',
            { code: 'invalid_installation_id' },
        );

    return sharedInstallationAuth(
        { appId, privateKey, installationId: Number(installationId) },
        createAuth,
    );
}

/** The most recently built installation resolver, and exactly what it was built from. */
let shared:
    | {
          credentials: InstallationCredentials;
          createAuth: InstallationTokenFactory;
          auth: GitHubEvidenceAuth;
      }
    | undefined;

/**
 * The installation resolver for `credentials`, built once and handed to every caller
 * that asks with the same credentials and factory.
 *
 * A pipeline, and with it a `SupportAgent`, is built for every job and every web QA
 * request. A resolver per agent would mean a `createAppAuth` per agent, and the SDK
 * keeps its token cache on the strategy instance — each `createAppAuth` starts an empty
 * one (`@octokit/auth-app@7.2.2` `dist-node/index.js:449-452`) — so every ticket that read
 * source would mint its own installation token. Sharing the resolver lets one token serve
 * investigation after investigation until the SDK refreshes it.
 *
 * The cache is all this buys. In-flight sharing is not per instance: the SDK shares every
 * pending read, cache hits included, through one module-level map keyed by installation id,
 * repositories and permissions — not by App, and not by `refresh` (`:99-114`, `:167-180`) —
 * so callers that overlap share one read whichever strategy they came through. An exchange
 * fills only the cache of the strategy that opened it (`:259`).
 *
 * One slot, not a map: a worker reads one fixed set of App credentials for its whole
 * life, so anything else that asks (a test with its own fake factory, a changed
 * configuration) replaces the slot rather than accumulating entries.
 */
function sharedInstallationAuth(
    credentials: InstallationCredentials,
    createAuth: InstallationTokenFactory,
): GitHubEvidenceAuth {
    if (
        shared &&
        shared.createAuth === createAuth &&
        shared.credentials.appId === credentials.appId &&
        shared.credentials.privateKey === credentials.privateKey &&
        shared.credentials.installationId === credentials.installationId
    )
        return shared.auth;
    const auth = installationAuth(credentials, createAuth);
    shared = { credentials, createAuth, auth };
    return auth;
}

/**
 * Mints installation tokens for evidence requests. The SDK decides when a cached token is due
 * for renewal; this resolver only asks it to skip that cache once what it holds has proved
 * unusable, and keeps one strategy for its whole life to do so. Building a new strategy
 * instead would not help: it still shares every read the old one had pending (see
 * `sharedInstallationAuth`), so a call that overlapped one could still be handed the old token.
 */
function installationAuth(
    credentials: InstallationCredentials,
    createAuth: InstallationTokenFactory,
): GitHubEvidenceAuth {
    let tokens: InstallationTokenSource | undefined;
    /** The bearer most recently handed out, and the time its age is counted from. */
    let issued: { authorization: string; since: number } | undefined;
    /** The last bearer GitHub refused once past its replication lag. Never handed out again. */
    let refused: string | undefined;
    /** Whether the next read must skip the strategy's cache. */
    let refresh = false;

    const read = (skipCache: boolean) =>
        mintWithoutLeaking(() => {
            // Built on first use, and inside the boundary. Not because the SDK's own checks quote
            // anything: `createAppAuth` throws only fixed messages (`@octokit/auth-app@7.2.2`
            // `dist-node/index.js:429-439`), and the OAuth strategy it builds checks nothing
            // (`@octokit/auth-oauth-app@8.1.4` `dist-bundle/index.js:75-90`). But `createAuth`
            // is whatever factory was injected, and a third-party error's text is untrusted.
            tokens ??= createAuth(credentials);
            // Re-invoked per request on purpose. The SDK caches the installation token for
            // 59 minutes and exchanges again once the entry lapses (`:43-50`, `:182-207`), a
            // minute inside GitHub's one-hour expiry; holding the string here would pin a
            // bearer that stops working an hour into the worker's uptime.
            return tokens({
                type: 'installation',
                installationId: credentials.installationId,
                permissions: EVIDENCE_PERMISSIONS,
                repositoryNames: [...EVIDENCE_REPOSITORIES],
                ...(skipCache && { refresh: true }),
            });
        });

    return {
        async authorization(signal) {
            // Ahead of any credential work: an investigation that has already run out of
            // time must not sign a JWT or open an exchange whose result nothing will read.
            signal?.throwIfAborted();
            try {
                let skippedCache = refresh;
                let minted = await read(skippedCache);
                // Asking for a refresh is not enough on its own. A read that overlaps one
                // already pending shares that read's promise whatever it asked for
                // (`@octokit/auth-app@7.2.2` `dist-node/index.js:167-180`), so a call made just
                // after a refusal — or one already under way when it landed — can come back
                // with the refused bearer. The shared read has settled and left the map by the
                // time this one resumes (`:177`), so asking again opens a read of its own or
                // joins a newer one; a second refused answer is a failure, never a credential.
                if (refused !== undefined && `Bearer ${minted.token}` === refused) {
                    skippedCache = true;
                    minted = await read(true);
                    if (`Bearer ${minted.token}` === refused)
                        throw new GitHubEvidenceAuthError(
                            'GitHub App installation token request for evidence returned a token GitHub had refused',
                            { code: 'token_exchange_failed' },
                        );
                }
                if (skippedCache) refresh = false;
                const authorization = `Bearer ${minted.token}`;
                // Aged from the SDK's own stamp. A source that reports none is aged from when
                // this resolver first handed the bearer out — a different bearer in between
                // starts the count again — which can only make it look younger than it is, so
                // this fallback errs toward keeping a token a little longer. (Taking the age at
                // the report rather than the send errs the other way; see
                // `TOKEN_REPLICATION_LAG_MS`.)
                const since =
                    minted.createdAt ??
                    (issued?.authorization === authorization ? issued.since : Date.now());
                issued = { authorization, since };
                return authorization;
            } catch (error) {
                // Whatever failed, the next read skips the cache. A 2xx that carried no usable
                // token is cached before it is returned (`dist-node/index.js:259`) and would be
                // served from there for 59 minutes (`:43-50`); a thrown exchange cached nothing
                // (the request at `:238-241` rejects before `:259` runs), so skipping the cache
                // costs it nothing.
                refresh = true;
                throw error;
            }
        },
        invalidate(refusedAuthorization) {
            // A refusal of a bearer this resolver has since replaced says nothing about the
            // one it hands out now.
            if (issued?.authorization !== refusedAuthorization) return;
            // GitHub briefly refuses a token it has only just issued. A refusal that arrives
            // while the token is younger than `TOKEN_REPLICATION_LAG_MS` is ignored, and the
            // next read reuses the token. The age is taken now, at the report, not when the
            // refused request was sent; that constant says how this differs from auth-app.
            if (Date.now() - issued.since < TOKEN_REPLICATION_LAG_MS) return;
            refused = refusedAuthorization;
            refresh = true;
        },
    };
}

function rejecting(reason: string, diagnostic: GitHubEvidenceAuthDiagnostic): GitHubEvidenceAuth {
    return {
        authorization: async () => {
            throw new GitHubEvidenceAuthError(reason, diagnostic);
        },
    };
}

/** A token the resolver can send, and when the source says it was minted. */
interface MintedToken {
    token: string;
    /** Epoch milliseconds; absent when the source reported no creation time. */
    createdAt?: number;
}

/**
 * Runs strategy construction and the token read inside one boundary, and resolves only with a
 * token that can actually be sent.
 *
 * What either step throws is text this module did not write, and is treated as untrusted. The
 * SDK's own messages for a rejected key are fixed strings (`@octokit/auth-app@7.2.2`
 * `dist-node/index.js:31-34`, `:429-439`; `universal-github-app-jwt@2.2.2`
 * `lib/get-token.js:23-35`). But a failed exchange's `RequestError` carries whatever body GitHub
 * or a proxy answered with (`@octokit/request@9.2.4` `dist-bundle/index.js:120-125`,
 * `:153-165`), a transport failure carries its cause's message (`:60-80`), and an injected
 * factory or source can throw anything at all, the key or a minted token included. Only the
 * underlying error's class name crosses the boundary — deliberately not its message, and not as
 * `cause`, which any structured logger would serialize straight back out.
 *
 * Even that class name stays inside `message`, which no consumer prints: a third-party strategy
 * chooses its own error names and nothing constrains them. What reaches the operator is the
 * `token_exchange_failed` category alone.
 */
async function mintWithoutLeaking(
    mint: () => Promise<{ token?: string; createdAt?: string }>,
): Promise<MintedToken> {
    // Each read once, and inside the boundary, so a result with no object to read — or one
    // whose fields throw when read — lands here too.
    let token: unknown;
    let createdAt: unknown;
    try {
        ({ token, createdAt } = await mint());
    } catch (caught) {
        const kind = caught instanceof Error ? caught.name : typeof caught;
        throw new GitHubEvidenceAuthError(
            `GitHub App installation token request for evidence failed (${kind})`,
            { code: 'token_exchange_failed' },
        );
    }
    // A 2xx is not a token. `@octokit/request@9.2.4` makes the response data whatever
    // `getResponseData` reads from the body (`dist-bundle/index.js:127`, `:130-149`): with no
    // content type, the text (`:132-133`); for `application/json` or `application/scim+json`,
    // the parsed body, or its raw text when that does not parse (`:136-143`); for any `text/*`
    // type, or any type with `charset=utf-8`, the text, a proxy's HTML page among them
    // (`:144-145`); for anything else, an ArrayBuffer (`:146-147`). A body that cannot be read
    // becomes `""`, or an empty ArrayBuffer on that last branch, and a 204 or 205 keeps the
    // initial `""` (`:92`, `:101-103`). `@octokit/auth-app@7.2.2` destructures `token` from that
    // data — `undefined` out of a string or an ArrayBuffer — then caches and returns it as a
    // success (`dist-node/index.js:229-241`, `:259`, `:273`), and later cache hits read the
    // entry back as `""` (`:57-64`). The message names the shape that failed, never the value.
    if (typeof token !== 'string' || !INSTALLATION_TOKEN.test(token)) throw noUsableToken();
    if (createdAt === undefined) return { token };
    // The SDK stamps every token it mints with an ISO time (`:246`) and reads it back as the
    // field after the token in its `|`-joined cache entry (`:57-64`). A creation time that is
    // not a time means that split landed inside the token, so the token beside it is a fragment.
    const created = typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;
    if (!Number.isFinite(created)) throw noUsableToken();
    return { token, createdAt: created };
}

function noUsableToken(): GitHubEvidenceAuthError {
    return new GitHubEvidenceAuthError(
        'GitHub App installation token request for evidence returned no usable token',
        { code: 'token_exchange_failed' },
    );
}

/**
 * Resolves with `pending`, or rejects the moment `signal` aborts — whichever comes first.
 *
 * The exchange behind `pending` is deliberately left running rather than cancelled:
 * `@octokit/auth-app` shares one in-flight token request between concurrent callers, so
 * cancelling on behalf of a single abandoned investigation would reject the others too.
 * Detaching lets it finish, settle for whoever is still waiting on it, and fill the cache
 * of the strategy that opened it for whoever asks next.
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
    if (authorization === undefined) return { Accept: 'application/vnd.github+json' };
    // `undefined` alone means "send no Authorization header". Anything else that is not a
    // scheme and a credential — an empty or whitespace-only string, a bare `Bearer `, a value
    // that is not a string at all — is a credential the resolver failed to produce, and sending
    // the request bare would turn that failure into the quietly rate-limited success the
    // resolver contract forbids. The `typeof` check is not redundant: `RegExp.test` stringifies
    // its argument, so `['Bearer x']` would otherwise pass and ride out as a header.
    if (typeof authorization !== 'string' || !AUTHORIZATION_VALUE.test(authorization))
        throw new GitHubEvidenceAuthError('GitHub evidence authentication resolved no credential');
    return { Accept: 'application/vnd.github+json', Authorization: authorization };
}

import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
    GitHubEvidenceAuthError,
    anonymousGitHubEvidenceAuth,
    githubEvidenceAuthDiagnostic,
    githubEvidenceAuthFromEnv,
    githubEvidenceHeaders,
    type InstallationTokenFactory,
    type InstallationTokenSource,
} from './github-evidence-auth.js';

/** Synthetic throughout: no test here may carry a credential that works anywhere. */
const CREDENTIALS = {
    GITHUB_APP_ID: '123456',
    GITHUB_PRIVATE_KEY:
        '-----BEGIN RSA PRIVATE KEY-----\nplaceholder\n-----END RSA PRIVATE KEY-----',
    GITHUB_INSTALLATION_ID: '7890',
};
const TOKEN = 'ghs_syntheticplaceholdertoken';

/** Stands in for `createAppAuth`, recording how the strategy is built and invoked. */
function fakeAppAuth(
    onAuth: InstallationTokenSource = async () => ({ token: TOKEN }),
    onCreate: () => void = () => {},
) {
    const auth = vi.fn<InstallationTokenSource>(onAuth);
    const create = vi.fn<InstallationTokenFactory>(() => {
        onCreate();
        return auth;
    });
    return { create, auth };
}

describe('GitHub evidence authentication', () => {
    it('reads no credential source beyond the three App environment variables', async () => {
        const { create } = fakeAppAuth();
        const auth = githubEvidenceAuthFromEnv(
            {
                ...CREDENTIALS,
                GITHUB_TOKEN: 'ghp_shouldbeignored',
                GH_TOKEN: 'ghp_shouldbeignored',
            },
            create,
        );
        await auth.authorization();
        expect(create).toHaveBeenCalledWith({
            appId: CREDENTIALS.GITHUB_APP_ID,
            privateKey: CREDENTIALS.GITHUB_PRIVATE_KEY,
            installationId: 7890,
        });
    });

    it('authorizes evidence requests with a metadata:read token narrowed to the CopilotKit repository', async () => {
        const { create, auth } = fakeAppAuth();
        const resolver = githubEvidenceAuthFromEnv(CREDENTIALS, create);
        expect(await resolver.authorization()).toBe(`Bearer ${TOKEN}`);
        expect(auth).toHaveBeenCalledWith({
            type: 'installation',
            installationId: 7890,
            permissions: { metadata: 'read' },
            repositoryNames: ['CopilotKit'],
        });
    });

    it('creates the App strategy lazily, so a run that reads no source mints no JWT', async () => {
        const { create } = fakeAppAuth();
        const resolver = githubEvidenceAuthFromEnv(CREDENTIALS, create);
        expect(create).not.toHaveBeenCalled();
        await resolver.authorization();
        await resolver.authorization();
        expect(create).toHaveBeenCalledTimes(1);
    });

    it('re-invokes the strategy per request so the SDK owns token caching and refresh', async () => {
        const { create, auth } = fakeAppAuth();
        const resolver = githubEvidenceAuthFromEnv(CREDENTIALS, create);
        await resolver.authorization();
        await resolver.authorization();
        await resolver.authorization();
        expect(auth).toHaveBeenCalledTimes(3);
    });

    // A SupportAgent is built per job and per web QA request, and each one asks for its
    // own resolver. The SDK's token cache lives in the strategy, so a resolver per agent
    // would mean a token exchange per ticket instead of one shared token.
    it('hands every agent the same resolver, so one strategy serves many investigations', async () => {
        const { create, auth } = fakeAppAuth();
        const first = githubEvidenceAuthFromEnv(CREDENTIALS, create);
        const second = githubEvidenceAuthFromEnv({ ...CREDENTIALS }, create);
        expect(second).toBe(first);
        await first.authorization();
        await second.authorization();
        expect(create).toHaveBeenCalledTimes(1);
        expect(auth).toHaveBeenCalledTimes(2);
    });

    it('shares the resolver on the production path, where the factory is defaulted', () => {
        // No authorization is requested, so the real `createAppAuth` is never built.
        expect(githubEvidenceAuthFromEnv(CREDENTIALS)).toBe(githubEvidenceAuthFromEnv(CREDENTIALS));
    });

    it('builds a fresh resolver when the credentials change', async () => {
        const { create } = fakeAppAuth();
        const first = githubEvidenceAuthFromEnv(CREDENTIALS, create);
        const moved = githubEvidenceAuthFromEnv(
            { ...CREDENTIALS, GITHUB_INSTALLATION_ID: '7891' },
            create,
        );
        expect(moved).not.toBe(first);
        await moved.authorization();
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ installationId: 7891 }));
    });

    it('does not pin a failed exchange on the shared resolver', async () => {
        const { create, auth } = fakeAppAuth();
        auth.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
        await expect(
            githubEvidenceAuthFromEnv(CREDENTIALS, create).authorization(),
        ).rejects.toBeInstanceOf(GitHubEvidenceAuthError);
        // The next ticket gets the same resolver, and it exchanges again.
        expect(await githubEvidenceAuthFromEnv(CREDENTIALS, create).authorization()).toBe(
            `Bearer ${TOKEN}`,
        );
    });

    /** A second synthetic key, standing in for a rotation of the configured one. */
    const ROTATED_PRIVATE_KEY =
        '-----BEGIN RSA PRIVATE KEY-----\nrotatedplaceholder\n-----END RSA PRIVATE KEY-----';

    // The slot is reused only when everything its strategy was built from matches, and each
    // part has to count on its own. A comparison that skipped the private key, say, would
    // leave a rotated key's investigations on a strategy still signing with the old one.
    it.each([
        {
            part: 'GITHUB_APP_ID',
            env: { GITHUB_APP_ID: '654321' },
            built: { appId: '654321' },
        },
        {
            part: 'GITHUB_PRIVATE_KEY',
            env: { GITHUB_PRIVATE_KEY: ROTATED_PRIVATE_KEY },
            built: { privateKey: ROTATED_PRIVATE_KEY },
        },
        {
            part: 'GITHUB_INSTALLATION_ID',
            env: { GITHUB_INSTALLATION_ID: '7891' },
            built: { installationId: 7891 },
        },
        { part: 'the token factory', env: {}, built: {}, newFactory: true },
    ])(
        'builds a fresh resolver when any part of its key changes: $part',
        async ({ env, built, newFactory }) => {
            const original = fakeAppAuth();
            const first = githubEvidenceAuthFromEnv(CREDENTIALS, original.create);
            // Built and serving, as the old strategy would be when the change lands.
            await first.authorization();
            const { create } = newFactory ? fakeAppAuth() : original;
            const changed = githubEvidenceAuthFromEnv({ ...CREDENTIALS, ...env }, create);
            expect(changed).not.toBe(first);
            await changed.authorization();
            expect(create).toHaveBeenLastCalledWith({
                appId: CREDENTIALS.GITHUB_APP_ID,
                privateKey: CREDENTIALS.GITHUB_PRIVATE_KEY,
                installationId: 7890,
                ...built,
            });
        },
    );

    // Construction is deferred to first use, so a strategy that failed to build must leave
    // the shared resolver unbuilt. Remembering the failure would fail every investigation
    // that followed, for as long as the worker stayed up.
    it('does not pin a failed strategy construction on the shared resolver', async () => {
        const { create, auth } = fakeAppAuth();
        create.mockImplementationOnce(() => {
            throw new TypeError('[@octokit/auth-app] strategy could not be built');
        });
        const first = githubEvidenceAuthFromEnv(CREDENTIALS, create);
        await expect(first.authorization()).rejects.toBeInstanceOf(GitHubEvidenceAuthError);
        // The next ticket gets the same resolver, and it builds the strategy again.
        const next = githubEvidenceAuthFromEnv(CREDENTIALS, create);
        expect(next).toBe(first);
        expect(await next.authorization()).toBe(`Bearer ${TOKEN}`);
        expect(create).toHaveBeenCalledTimes(2);
        expect(auth).toHaveBeenCalledTimes(1);
    });

    it('serves anonymous public reads only when no App credential is configured', async () => {
        const { create } = fakeAppAuth();
        const resolver = githubEvidenceAuthFromEnv({}, create);
        expect(await resolver.authorization()).toBeUndefined();
        expect(create).not.toHaveBeenCalled();
    });

    it('treats blank-but-present credentials as unconfigured rather than partial', async () => {
        const resolver = githubEvidenceAuthFromEnv(
            { GITHUB_APP_ID: '  ', GITHUB_PRIVATE_KEY: '', GITHUB_INSTALLATION_ID: '\n' },
            fakeAppAuth().create,
        );
        expect(await resolver.authorization()).toBeUndefined();
    });

    it.each([
        {
            name: 'private key and installation id missing',
            env: { GITHUB_APP_ID: CREDENTIALS.GITHUB_APP_ID },
            missing: ['GITHUB_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID'],
        },
        {
            name: 'installation id missing',
            env: {
                GITHUB_APP_ID: CREDENTIALS.GITHUB_APP_ID,
                GITHUB_PRIVATE_KEY: CREDENTIALS.GITHUB_PRIVATE_KEY,
            },
            missing: ['GITHUB_INSTALLATION_ID'],
        },
        {
            name: 'app id missing',
            env: {
                GITHUB_PRIVATE_KEY: CREDENTIALS.GITHUB_PRIVATE_KEY,
                GITHUB_INSTALLATION_ID: CREDENTIALS.GITHUB_INSTALLATION_ID,
            },
            missing: ['GITHUB_APP_ID'],
        },
    ])('fails partial App configuration instead of falling back anonymously: $name', async (c) => {
        const { create } = fakeAppAuth();
        const resolver = githubEvidenceAuthFromEnv(c.env, create);
        const error = await resolver.authorization().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(GitHubEvidenceAuthError);
        for (const name of c.missing) expect((error as Error).message).toContain(name);
        expect(create).not.toHaveBeenCalled();
    });

    it.each(['abc', '0', '-7', '1.5', '7890abc', '1e3'])(
        'fails a malformed GITHUB_INSTALLATION_ID instead of falling back anonymously: %s',
        async (installationId) => {
            const { create } = fakeAppAuth();
            const resolver = githubEvidenceAuthFromEnv(
                { ...CREDENTIALS, GITHUB_INSTALLATION_ID: installationId },
                create,
            );
            await expect(resolver.authorization()).rejects.toBeInstanceOf(GitHubEvidenceAuthError);
            expect(create).not.toHaveBeenCalled();
        },
    );

    it('surfaces a strategy failure without echoing the private key or the minted token', async () => {
        const leaky = new RangeError(
            `secretOrPrivateKey ${CREDENTIALS.GITHUB_PRIVATE_KEY} rejected while minting ${TOKEN}`,
        );
        const { create } = fakeAppAuth(() => Promise.reject(leaky));
        const resolver = githubEvidenceAuthFromEnv(CREDENTIALS, create);
        const error = await resolver.authorization().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(GitHubEvidenceAuthError);
        const rendered = `${(error as Error).message} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
        expect(rendered).not.toContain(TOKEN);
        expect(rendered).not.toContain('placeholder');
        expect(rendered).not.toContain(leaky.message);
        expect((error as Error).message).toContain('RangeError');
    });

    it('builds evidence headers that carry the token only when one was resolved', async () => {
        expect(await githubEvidenceHeaders(anonymousGitHubEvidenceAuth)).toEqual({
            Accept: 'application/vnd.github+json',
        });
        expect(
            await githubEvidenceHeaders(
                githubEvidenceAuthFromEnv(CREDENTIALS, fakeAppAuth().create),
            ),
        ).toEqual({
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${TOKEN}`,
        });
    });

    it('propagates an authorization failure rather than sending an unauthenticated request', async () => {
        const resolver = githubEvidenceAuthFromEnv(
            { GITHUB_APP_ID: CREDENTIALS.GITHUB_APP_ID },
            fakeAppAuth().create,
        );
        await expect(githubEvidenceHeaders(resolver)).rejects.toBeInstanceOf(
            GitHubEvidenceAuthError,
        );
    });

    it('surfaces a synchronous strategy construction failure without echoing the private key', async () => {
        // auth-app's own option checks throw fixed strings (`dist-node/index.js:429-439`). This
        // stand-in quotes the key, as an injected factory could, to show the boundary holds anyway.
        const leaky = new TypeError(
            `[@octokit/auth-app] privateKey ${CREDENTIALS.GITHUB_PRIVATE_KEY} is malformed`,
        );
        const { create, auth } = fakeAppAuth(undefined, () => {
            throw leaky;
        });
        const resolver = githubEvidenceAuthFromEnv(CREDENTIALS, create);
        const error = await resolver.authorization().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(GitHubEvidenceAuthError);
        const rendered = `${(error as Error).message} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
        expect(rendered).not.toContain('placeholder');
        expect(rendered).not.toContain(leaky.message);
        expect((error as Error).message).toContain('TypeError');
        expect(auth).not.toHaveBeenCalled();
    });

    describe('operator diagnostic', () => {
        /** The whole closed set a log line may say; anything else is a value that escaped. */
        const OPERATOR_VOCABULARY = [
            'partial_configuration',
            'invalid_installation_id',
            'token_exchange_failed',
            'auth_unavailable',
        ];

        it('names which App variables a partial configuration is missing', async () => {
            const resolver = githubEvidenceAuthFromEnv(
                { GITHUB_APP_ID: CREDENTIALS.GITHUB_APP_ID },
                fakeAppAuth().create,
            );
            const error = await resolver.authorization().catch((caught: unknown) => caught);
            expect(githubEvidenceAuthDiagnostic(error)).toEqual({
                code: 'partial_configuration',
                missing: ['GITHUB_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID'],
            });
        });

        it('separates a malformed installation id from a missing one', async () => {
            const resolver = githubEvidenceAuthFromEnv(
                { ...CREDENTIALS, GITHUB_INSTALLATION_ID: '1e3' },
                fakeAppAuth().create,
            );
            const error = await resolver.authorization().catch((caught: unknown) => caught);
            expect(githubEvidenceAuthDiagnostic(error)).toEqual({
                code: 'invalid_installation_id',
            });
        });

        it('reports a failed token exchange without the key or token that failed it', async () => {
            const leaky = new RangeError(
                `secretOrPrivateKey ${CREDENTIALS.GITHUB_PRIVATE_KEY} rejected while minting ${TOKEN}`,
            );
            const { create } = fakeAppAuth(() => Promise.reject(leaky));
            const resolver = githubEvidenceAuthFromEnv(CREDENTIALS, create);
            const error = await resolver.authorization().catch((caught: unknown) => caught);
            const diagnostic = githubEvidenceAuthDiagnostic(error);
            expect(diagnostic).toEqual({ code: 'token_exchange_failed' });
            // The underlying class name reached the error message; it must not reach the log,
            // because nothing constrains what a third-party strategy names its errors.
            expect(JSON.stringify(diagnostic)).not.toContain('RangeError');
        });

        // `githubAuth` is an injectable seam, so a `GitHubEvidenceAuthError` can arrive carrying
        // anything at all. The log line is built from the allowlist, never from what it was handed.
        it('discards a forged code and forged variable names', () => {
            const forged = new GitHubEvidenceAuthError(
                `-----BEGIN RSA PRIVATE KEY-----\nplaceholder\n-----END RSA PRIVATE KEY-----`,
                {
                    code: 'partial_configuration',
                    missing: [
                        'GITHUB_PRIVATE_KEY',
                        'ghs_syntheticplaceholdertoken',
                        '10.1.2.3',
                    ] as never,
                },
            );
            expect(githubEvidenceAuthDiagnostic(forged)).toEqual({
                code: 'partial_configuration',
                missing: ['GITHUB_PRIVATE_KEY'],
            });
            const unknownCode = new GitHubEvidenceAuthError('boom', {
                code: 'sudo_make_me_a_sandwich' as never,
            });
            expect(githubEvidenceAuthDiagnostic(unknownCode)).toEqual({ code: 'auth_unavailable' });
            // Nothing recognizable survives the filter, so the claim itself is not repeated.
            const noneRecognized = new GitHubEvidenceAuthError('boom', {
                code: 'partial_configuration',
                missing: '10.1.2.3' as never,
            });
            expect(githubEvidenceAuthDiagnostic(noneRecognized)).toEqual({
                code: 'auth_unavailable',
            });
        });

        // A `diagnostic` arriving through the `githubAuth` seam is an object its author owns
        // outright, so its properties can be getters. Validating one read and returning another
        // would let a value that never passed the allowlist reach the operator log.
        it('discards a code that changes between the allowlist check and the return', () => {
            const synthetic = 'ghs_syntheticplaceholdertoken';
            const shifting = (first: string) => {
                let reads = 0;
                return new GitHubEvidenceAuthError('boom', {
                    get code() {
                        reads += 1;
                        return (reads === 1 ? first : synthetic) as never;
                    },
                    missing: ['GITHUB_APP_ID'],
                });
            };

            // The code is read again to pick the return branch, and again to build the result.
            const viaDirectReturn = githubEvidenceAuthDiagnostic(shifting('token_exchange_failed'));
            expect(OPERATOR_VOCABULARY).toContain(viaDirectReturn.code);
            expect(JSON.stringify(viaDirectReturn)).not.toContain(synthetic);

            // The partial-configuration branch reads it once more, after the name filter.
            const viaMissingBranch = githubEvidenceAuthDiagnostic(
                shifting('partial_configuration'),
            );
            expect(OPERATOR_VOCABULARY).toContain(viaMissingBranch.code);
            expect(JSON.stringify(viaMissingBranch)).not.toContain(synthetic);
        });

        // Classifying is a recoverable path: the evidence read degrades to `auth_unavailable`.
        // A malformed claim must not raise out of the classifier and make the failure fatal.
        it('survives a missing list that is an array only when it is checked', () => {
            let reads = 0;
            const arrayThenNull = new GitHubEvidenceAuthError('boom', {
                code: 'partial_configuration',
                get missing() {
                    reads += 1;
                    return (reads === 1 ? ['GITHUB_APP_ID'] : null) as never;
                },
            });

            expect(githubEvidenceAuthDiagnostic(arrayThenNull)).toEqual({
                code: 'partial_configuration',
                missing: ['GITHUB_APP_ID'],
            });

            // The inverse: what the type guard rejected is what the filter must see.
            let inverseReads = 0;
            const stringThenArray = new GitHubEvidenceAuthError('boom', {
                code: 'partial_configuration',
                get missing() {
                    inverseReads += 1;
                    return (inverseReads === 1 ? '10.1.2.3' : ['GITHUB_APP_ID']) as never;
                },
            });

            expect(githubEvidenceAuthDiagnostic(stringThenArray)).toEqual({
                code: 'auth_unavailable',
            });
        });

        it('falls back to the generic category for an error carrying no diagnostic', () => {
            expect(githubEvidenceAuthDiagnostic(new GitHubEvidenceAuthError('boom'))).toEqual({
                code: 'auth_unavailable',
            });
            expect(githubEvidenceAuthDiagnostic(new TypeError('not a credential failure'))).toEqual(
                { code: 'auth_unavailable' },
            );
            expect(githubEvidenceAuthDiagnostic('ghs_syntheticplaceholdertoken')).toEqual({
                code: 'auth_unavailable',
            });
        });
    });

    describe('investigation cancellation', () => {
        /** A token source that never settles, standing in for a stalled exchange. */
        function stalled() {
            const { create, auth } = fakeAppAuth(() => new Promise<{ token: string }>(() => {}));
            return { create, auth, resolver: githubEvidenceAuthFromEnv(CREDENTIALS, create) };
        }

        it('rejects an unresolved authorization once the investigation signal aborts', async () => {
            const { resolver } = stalled();
            const controller = new AbortController();
            const reason = new DOMException('Investigation deadline', 'TimeoutError');
            const headers = githubEvidenceHeaders(resolver, controller.signal);
            controller.abort(reason);
            await expect(headers).rejects.toBe(reason);
        });

        it('makes cancellation terminal rather than a recoverable auth failure', async () => {
            const { resolver } = stalled();
            const controller = new AbortController();
            const reason = new DOMException('Investigation deadline', 'TimeoutError');
            const headers = githubEvidenceHeaders(resolver, controller.signal);
            controller.abort(reason);
            const error = await headers.catch((caught: unknown) => caught);
            expect(error).not.toBeInstanceOf(GitHubEvidenceAuthError);
            expect((error as Error).name).toBe('TimeoutError');
        });

        it('never reaches the resolver at all when the signal is already aborted', async () => {
            const authorization = vi.fn(async () => `Bearer ${TOKEN}`);
            const controller = new AbortController();
            controller.abort(new DOMException('Already over', 'TimeoutError'));
            await expect(
                githubEvidenceHeaders({ authorization }, controller.signal),
            ).rejects.toHaveProperty('name', 'TimeoutError');
            expect(authorization).not.toHaveBeenCalled();
        });

        it('rejects when the deadline lands while the exchange is being opened', async () => {
            const controller = new AbortController();
            const reason = new DOMException('Investigation deadline', 'TimeoutError');
            // Aborts synchronously, before the race can subscribe. No abort event follows,
            // so only reading the signal's settled state can end this wait.
            const authorization = vi.fn(() => {
                controller.abort(reason);
                return new Promise<string>(() => {});
            });
            await expect(githubEvidenceHeaders({ authorization }, controller.signal)).rejects.toBe(
                reason,
            );
        });

        it('does no credential work when the signal is already aborted', async () => {
            const { create, auth, resolver } = stalled();
            const controller = new AbortController();
            controller.abort(new DOMException('Already over', 'TimeoutError'));
            await expect(githubEvidenceHeaders(resolver, controller.signal)).rejects.toThrow();
            await expect(resolver.authorization(controller.signal)).rejects.toThrow();
            expect(create).not.toHaveBeenCalled();
            expect(auth).not.toHaveBeenCalled();
        });

        it.each([
            { name: 'success', onAuth: async () => ({ token: TOKEN }) },
            { name: 'failure', onAuth: () => Promise.reject(new Error('exchange refused')) },
        ])('drops its abort listener when authorization settles: $name', async ({ onAuth }) => {
            const resolver = githubEvidenceAuthFromEnv(CREDENTIALS, fakeAppAuth(onAuth).create);
            const controller = new AbortController();
            const added = vi.spyOn(controller.signal, 'addEventListener');
            const removed = vi.spyOn(controller.signal, 'removeEventListener');
            await githubEvidenceHeaders(resolver, controller.signal).catch(() => undefined);
            expect(added).toHaveBeenCalledTimes(1);
            expect(removed).toHaveBeenCalledTimes(1);
            expect(removed.mock.calls[0]?.[1]).toBe(added.mock.calls[0]?.[1]);
        });

        it('leaves the shared exchange running so a concurrent investigation still gets its token', async () => {
            let settle: (value: { token: string }) => void = () => {};
            const { create, auth } = fakeAppAuth(
                () => new Promise<{ token: string }>((resolve) => (settle = resolve)),
            );
            const resolver = githubEvidenceAuthFromEnv(CREDENTIALS, create);
            const abandoned = new AbortController();
            const patient = new AbortController();

            const first = githubEvidenceHeaders(resolver, abandoned.signal);
            const second = githubEvidenceHeaders(resolver, patient.signal);
            abandoned.abort(new DOMException('Investigation deadline', 'TimeoutError'));

            await expect(first).rejects.toHaveProperty('name', 'TimeoutError');
            settle({ token: TOKEN });
            // One investigation giving up must not cancel the credential the other needs.
            await expect(second).resolves.toEqual({
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${TOKEN}`,
            });
            expect(create).toHaveBeenCalledTimes(1);
            expect(auth).toHaveBeenCalledTimes(2);
        });

        it('does not leave a late exchange rejection unhandled after the caller gave up', async () => {
            let fail: (error: Error) => void = () => {};
            const resolver = githubEvidenceAuthFromEnv(
                CREDENTIALS,
                fakeAppAuth(() => new Promise<{ token: string }>((_, reject) => (fail = reject)))
                    .create,
            );
            const controller = new AbortController();
            const unhandled: unknown[] = [];
            const record = (reason: unknown) => unhandled.push(reason);
            process.on('unhandledRejection', record);
            try {
                const headers = githubEvidenceHeaders(resolver, controller.signal);
                controller.abort(new DOMException('Investigation deadline', 'TimeoutError'));
                await expect(headers).rejects.toThrow();
                fail(new Error('exchange refused after the caller left'));
                await new Promise((resolve) => setTimeout(resolve, 10));
            } finally {
                process.off('unhandledRejection', record);
            }
            expect(unhandled).toEqual([]);
        });
    });
});

describe('GitHub evidence authentication: tokens GitHub will not accept', () => {
    const rendered = (error: unknown) =>
        `${(error as Error).message} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;

    // Shapes a token source can resolve with that no request can carry. What is asserted here is
    // this module's reading of a result, whichever source produced it, so a plain fake will do;
    // the same shapes arriving through the real SDK are covered further down.
    const MALFORMED = [
        { name: 'no token at all', token: undefined },
        { name: 'an empty token', token: '' },
        { name: 'a token of only whitespace', token: ' \t ' },
        { name: 'a token with a space in it', token: 'ghs_synthetic exchange1' },
        { name: 'a token no header can carry', token: 'ghs_syntheticexchange1\r\nX-Injected: 1' },
        { name: 'a token the SDK cache would cut at its |', token: 'ghs_synthetic|exchange1' },
        { name: 'a token with a control character in it', token: 'ghs_synthetic\u0000exchange1' },
        // `RegExp.test` stringifies what it is given, so only a `typeof` check stops this one.
        { name: 'a token that is not a string', token: ['ghs_syntheticexchange1'] },
    ];

    it.each(MALFORMED)('rejects a 2xx exchange that yielded $name', async ({ token }) => {
        const { create } = fakeAppAuth(async () => ({ token: token as string | undefined }));
        const error = await githubEvidenceAuthFromEnv(CREDENTIALS, create)
            .authorization()
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(GitHubEvidenceAuthError);
        expect((error as GitHubEvidenceAuthError).diagnostic).toEqual({
            code: 'token_exchange_failed',
        });
        expect(githubEvidenceAuthDiagnostic(error)).toEqual({ code: 'token_exchange_failed' });
        expect(rendered(error)).not.toContain('ghs_synthetic');
        expect(rendered(error)).not.toContain('placeholder');
    });

    // The result is read inside the no-leak boundary. Read outside it, a source that resolves to
    // nothing raises a bare TypeError the agent treats as a programmer error, and a field that
    // throws carries its own message — here, the key and the token — straight past it.
    it.each([
        { name: 'resolves to nothing', result: () => null },
        {
            name: 'throws from its token field',
            result: () => ({
                get token(): string {
                    throw new Error(`minted ${TOKEN} with ${CREDENTIALS.GITHUB_PRIVATE_KEY}`);
                },
            }),
        },
        {
            name: 'throws from its creation time',
            result: () => ({
                token: TOKEN,
                get createdAt(): string {
                    throw new Error(`minted ${TOKEN} with ${CREDENTIALS.GITHUB_PRIVATE_KEY}`);
                },
            }),
        },
    ])('keeps a source result that $name inside the boundary', async ({ result }) => {
        const { create } = fakeAppAuth(async () => result() as never);
        const error = await githubEvidenceAuthFromEnv(CREDENTIALS, create)
            .authorization()
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(GitHubEvidenceAuthError);
        expect(githubEvidenceAuthDiagnostic(error)).toEqual({ code: 'token_exchange_failed' });
        expect(rendered(error)).not.toContain('ghs_synthetic');
        expect(rendered(error)).not.toContain('placeholder');
    });

    // What a cache hit on a `|`-bearing token looks like from `@octokit/auth-app@7.2.2`: the
    // entry is split on `|` (`dist-node/index.js:57-64`), so the token comes back cut short —
    // still a plausible bearer — and the creation time is whatever followed the cut.
    it('rejects a token whose creation time is not a time, the mark of a cache entry split inside it', async () => {
        const { create } = fakeAppAuth(async () => ({
            token: 'ghs_synthetic',
            createdAt: 'exchange1',
        }));
        const error = await githubEvidenceAuthFromEnv(CREDENTIALS, create)
            .authorization()
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(GitHubEvidenceAuthError);
        expect(githubEvidenceAuthDiagnostic(error)).toEqual({ code: 'token_exchange_failed' });
    });

    // A source that ignores `refresh` — or a refresh that keeps landing on someone else's read of
    // the old token — must cost a failed read, never the refused bearer.
    it('fails rather than hand back a refused bearer when the source keeps returning it', async () => {
        const createdAt = new Date(Date.now() - 60_000).toISOString();
        const { create, auth } = fakeAppAuth(async () => ({ token: TOKEN, createdAt }));
        const resolver = githubEvidenceAuthFromEnv(CREDENTIALS, create);
        expect(await resolver.authorization()).toBe(`Bearer ${TOKEN}`);
        resolver.invalidate?.(`Bearer ${TOKEN}`);
        const error = await resolver.authorization().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(GitHubEvidenceAuthError);
        expect(githubEvidenceAuthDiagnostic(error)).toEqual({ code: 'token_exchange_failed' });
        expect(rendered(error)).not.toContain(TOKEN);
        // It asked for a refresh, then asked once more when the answer was still the refused one.
        expect(auth.mock.calls.slice(1).map(([options]) => options.refresh)).toEqual([true, true]);
    });

    // `undefined` is the only value that means "read anonymously". Anything else a resolver hands
    // back that is not a scheme and a credential is one it failed to produce, and must not
    // quietly become an anonymous read — nor ride out as a header GitHub can only refuse.
    it.each([
        { name: 'an empty string', value: '' },
        { name: 'null', value: null },
        { name: 'whitespace alone', value: '  \t ' },
        { name: 'a scheme with no credential', value: 'Bearer ' },
        { name: 'a bare scheme', value: 'Bearer' },
        { name: 'a credential with no scheme', value: TOKEN },
        { name: 'a credential split by a line break', value: `Bearer ${TOKEN}\r\nX-Injected: 1` },
        // `RegExp.test` stringifies what it is given, so only a `typeof` check stops these.
        { name: 'an array that reads as a header', value: [`Bearer ${TOKEN}`] },
        {
            name: 'an object that reads as a header',
            value: { toString: (): string => `Bearer ${TOKEN}` },
        },
    ])(
        'refuses a resolver that resolves to $name instead of reading anonymously',
        async ({ value }) => {
            await expect(
                githubEvidenceHeaders({ authorization: async () => value as never }),
            ).rejects.toBeInstanceOf(GitHubEvidenceAuthError);
        },
    );
});

// The real SDK stamps every token it reports (`dist-node/index.js:246`), so it cannot exercise the
// fallback for a source that reports no creation time. A plain source stands in for one.
describe('GitHub evidence authentication: a source that reports no creation time', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
    });
    afterEach(() => vi.useRealTimers());
    const elapse = (ms: number) => vi.setSystemTime(Date.now() + ms);

    /** Serves one token until asked to refresh, then mints the next. Never reports `createdAt`. */
    function undatedSource() {
        let minted = 0;
        return fakeAppAuth(async ({ refresh }) => {
            if (refresh || minted === 0) minted += 1;
            return { token: `ghs_syntheticundated${minted}` };
        });
    }
    const refreshes = (auth: ReturnType<typeof undatedSource>['auth']) =>
        auth.mock.calls.map(([options]) => options.refresh);

    it('ignores a refusal that lands under five seconds after the bearer was first handed out', async () => {
        const { create, auth } = undatedSource();
        const resolver = githubEvidenceAuthFromEnv(CREDENTIALS, create);
        const bearer = (await resolver.authorization()) as string;
        elapse(4_999);
        resolver.invalidate?.(bearer);
        expect(await resolver.authorization()).toBe(bearer);
        expect(refreshes(auth)).toEqual([undefined, undefined]);
    });

    it('acts on one five seconds after the first hand-out, however recently it was handed out again', async () => {
        const { create, auth } = undatedSource();
        const resolver = githubEvidenceAuthFromEnv(CREDENTIALS, create);
        const bearer = (await resolver.authorization()) as string;
        elapse(4_000);
        expect(await resolver.authorization()).toBe(bearer);
        elapse(1_000);
        resolver.invalidate?.(bearer);
        expect(await resolver.authorization()).toBe('Bearer ghs_syntheticundated2');
        expect(refreshes(auth)).toEqual([undefined, undefined, true]);
    });

    it('ages a replacement from its own first hand-out, not from the bearer it replaced', async () => {
        const { create, auth } = undatedSource();
        const resolver = githubEvidenceAuthFromEnv(CREDENTIALS, create);
        const first = (await resolver.authorization()) as string;
        elapse(60_000);
        resolver.invalidate?.(first);
        const replacement = (await resolver.authorization()) as string;
        expect(replacement).toBe('Bearer ghs_syntheticundated2');
        elapse(4_999);
        resolver.invalidate?.(replacement);
        expect(await resolver.authorization()).toBe(replacement);
        expect(refreshes(auth)).toEqual([undefined, true, undefined]);
    });
});

/**
 * Contract tests: the resolver driven over the production factory — the real `createAppAuth`
 * from `@octokit/auth-app@7.2.2` and a real Octokit request — entirely offline. The only stand-in
 * is the global `fetch` that request ends in, answering GitHub's token endpoint with tokens the
 * test controls, so the SDK's cache, its module-wide sharing of pending reads and its refresh
 * path are the real ones.
 */
describe('GitHub evidence authentication over the real @octokit/auth-app', () => {
    // Generated for this run and registered with no App anywhere: auth-app signs a genuine JWT
    // with it, and nothing ever checks that signature.
    const { privateKey: SYNTHETIC_KEY } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const TOKEN_ENDPOINT = 'https://api.github.com/app/installations/7890/access_tokens';
    const rendered = (error: unknown) =>
        `${(error as Error).message} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;

    /**
     * A distinct App id per resolver. The shared slot is keyed by credentials, so no test inherits
     * another's strategy or its cache; the installation stays the same, as in production.
     */
    let nextAppId = 900_000;
    function resolver() {
        nextAppId += 1;
        return githubEvidenceAuthFromEnv({
            GITHUB_APP_ID: String(nextAppId),
            GITHUB_PRIVATE_KEY: SYNTHETIC_KEY,
            GITHUB_INSTALLATION_ID: '7890',
        });
    }

    interface Reply {
        status?: number;
        contentType?: string;
        body: string | null;
    }
    /** GitHub's installation-token response: it carries `expires_at`, and no creation time. */
    const granted = (token: string): Reply => ({
        body: JSON.stringify({
            token,
            expires_at: new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z'),
            permissions: { metadata: 'read' },
            repository_selection: 'selected',
        }),
    });

    /**
     * Stands in for GitHub's token endpoint. Each exchange is numbered the moment it arrives —
     * before anything is awaited, so overlapping exchanges can never share a number — and mints
     * `ghs_syntheticexchange<n>` unless the test planned another reply for it. A planned reply
     * may be a promise the test settles later, which holds that exchange in flight.
     */
    function tokenEndpoint(planned: (Reply | Promise<Reply> | undefined)[] = []) {
        const exchanges: { authorization: string | null; body: unknown }[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>(async (input, init) => {
                const url = input instanceof Request ? input.url : String(input);
                if (url !== TOKEN_ENDPOINT || init?.method !== 'POST')
                    throw new Error(`unexpected request to ${url}`);
                const exchange = exchanges.push({
                    authorization: new Headers(init.headers).get('authorization'),
                    body: JSON.parse(String(init.body)),
                });
                const reply =
                    (await planned.shift()) ?? granted(`ghs_syntheticexchange${exchange}`);
                return new Response(reply.body, {
                    status: reply.status ?? 201,
                    headers: {
                        'content-type': reply.contentType ?? 'application/json; charset=utf-8',
                    },
                });
            }),
        );
        return exchanges;
    }

    /** Waits, without moving the test's clock, until `count` exchanges have reached GitHub. */
    async function exchangesReach(exchanges: unknown[], count: number) {
        for (let turn = 0; exchanges.length < count; turn += 1) {
            if (turn > 1_000) throw new Error(`${exchanges.length} of ${count} exchanges arrived`);
            await new Promise((resolve) => setImmediate(resolve));
        }
    }

    // The SDK stamps a token's creation time from the clock (`dist-node/index.js:246`), and the
    // resolver ages a refused token from that stamp, so the clock is the test's to move.
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });
    const elapse = (ms: number) => vi.setSystemTime(Date.now() + ms);

    it('mints once, signed as the App and narrowed to metadata:read on CopilotKit, then serves the SDK cache', async () => {
        const exchanges = tokenEndpoint();
        const auth = resolver();
        expect(await auth.authorization()).toBe('Bearer ghs_syntheticexchange1');
        elapse(60_000);
        expect(await auth.authorization()).toBe('Bearer ghs_syntheticexchange1');
        expect(exchanges).toHaveLength(1);
        expect(exchanges[0]?.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
        expect(exchanges[0]?.body).toEqual({
            permissions: { metadata: 'read' },
            repositories: ['CopilotKit'],
        });
    });

    // Each of these is a 2xx the SDK returns as a success and caches on the strategy this
    // resolver keeps for its whole life (`dist-node/index.js:229-273`).
    it.each<{ name: string; reply: Reply }>([
        {
            name: 'a JSON body with no token',
            reply: { body: JSON.stringify({ expires_at: '2026-10-19T13:00:00Z' }) },
        },
        {
            name: "a proxy's HTML page",
            reply: {
                status: 200,
                contentType: 'text/html; charset=utf-8',
                body: '<html><body>ghs_syntheticproxy sign-in</body></html>',
            },
        },
        {
            name: 'a binary body',
            reply: {
                status: 200,
                contentType: 'application/octet-stream',
                body: 'ghs_syntheticbinary',
            },
        },
        { name: 'no body at all', reply: { status: 204, body: null } },
        { name: 'an empty token', reply: granted('') },
        { name: 'a token of only whitespace', reply: granted(' \t ') },
        { name: 'a token with a space in it', reply: granted('ghs_synthetic exchange1') },
        { name: 'a token with a line break in it', reply: granted('ghs_synthetic\nexchange1') },
        { name: 'a token with a | in it', reply: granted('ghs_synthetic|exchange1') },
    ])(
        'rejects $name, then exchanges again rather than serve what the SDK cached',
        async ({ reply }) => {
            const exchanges = tokenEndpoint([reply]);
            const auth = resolver();
            const error = await auth.authorization().catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(GitHubEvidenceAuthError);
            expect(githubEvidenceAuthDiagnostic(error)).toEqual({ code: 'token_exchange_failed' });
            expect(rendered(error)).not.toContain('ghs_synthetic');
            expect(rendered(error)).not.toContain('PRIVATE KEY');
            // The next investigation gets this same resolver, and the SDK still holds that reply.
            expect(await auth.authorization()).toBe('Bearer ghs_syntheticexchange2');
            expect(exchanges).toHaveLength(2);
            // Recovering costs one exchange, not one per request: the healthy token is cached.
            expect(await auth.authorization()).toBe('Bearer ghs_syntheticexchange2');
            expect(exchanges).toHaveLength(2);
        },
    );

    it('refuses a malformed exchange to every caller that shared it', async () => {
        let settle: (reply: Reply) => void = () => {};
        const exchanges = tokenEndpoint([new Promise<Reply>((resolve) => (settle = resolve))]);
        const auth = resolver();
        const first = auth.authorization();
        const second = auth.authorization();
        await exchangesReach(exchanges, 1);
        settle(granted('ghs_synthetic|exchange1'));
        await expect(first).rejects.toBeInstanceOf(GitHubEvidenceAuthError);
        await expect(second).rejects.toBeInstanceOf(GitHubEvidenceAuthError);
        expect(await auth.authorization()).toBe('Bearer ghs_syntheticexchange2');
        expect(exchanges).toHaveLength(2);
    });

    // auth-app's request hook retries a 401 to an attempt it sent while the token was under five
    // seconds old (`dist-node/index.js:337`, `:399-412`). The resolver uses the same five seconds,
    // but takes the token's age when the 401 is reported to it, so that is the age moved here:
    // there is no request in this test, only the report.
    it('keeps a token GitHub refused inside its replication lag, and retires it once past it', async () => {
        const exchanges = tokenEndpoint();
        const auth = resolver();
        const refused = (await auth.authorization()) as string;
        elapse(4_999);
        auth.invalidate?.(refused);
        expect(await auth.authorization()).toBe(refused);
        expect(exchanges).toHaveLength(1);
        elapse(1);
        auth.invalidate?.(refused);
        expect(await auth.authorization()).toBe('Bearer ghs_syntheticexchange2');
        expect(exchanges).toHaveLength(2);
    });

    it('answers a refusal past the lag with a different bearer, at the cost of one exchange', async () => {
        const exchanges = tokenEndpoint();
        const auth = resolver();
        const refused = (await auth.authorization()) as string;
        elapse(60_000);
        auth.invalidate?.(refused);
        const replacement = await auth.authorization();
        expect(replacement).toBe('Bearer ghs_syntheticexchange2');
        expect(exchanges).toHaveLength(2);
        // The SDK cached the replacement over the refused token, so it serves every later call.
        expect(await auth.authorization()).toBe(replacement);
        expect(exchanges).toHaveLength(2);
    });

    it('ignores a refusal that names a bearer it no longer hands out', async () => {
        const exchanges = tokenEndpoint();
        const auth = resolver();
        const refused = (await auth.authorization()) as string;
        elapse(60_000);
        auth.invalidate?.(refused);
        const replacement = await auth.authorization();
        elapse(60_000);
        // A request that carried the old bearer reports late; something reports a stranger.
        auth.invalidate?.(refused);
        auth.invalidate?.('Bearer ghs_syntheticneverissued');
        expect(await auth.authorization()).toBe(replacement);
        expect(exchanges).toHaveLength(2);
    });

    // The SDK shares one pending read per installation and permissions across every caller, and
    // its key ignores `refresh` (`dist-node/index.js:99-114`, `:167-180`). A call that was
    // already reading the cache when the refusal landed, and one made just after it, both get
    // that read's answer: the refused bearer.
    it('never hands the refused bearer to a call already reading, or to one that joined it', async () => {
        const exchanges = tokenEndpoint();
        const auth = resolver();
        const refused = (await auth.authorization()) as string;
        elapse(60_000);
        const underway = auth.authorization();
        auth.invalidate?.(refused);
        const joined = auth.authorization();
        expect(await Promise.all([underway, joined])).toEqual([
            'Bearer ghs_syntheticexchange2',
            'Bearer ghs_syntheticexchange2',
        ]);
        expect(exchanges).toHaveLength(2);
    });

    it('shares one refresh among the calls that need it while it is in flight', async () => {
        let settle: (reply: Reply) => void = () => {};
        const exchanges = tokenEndpoint([
            undefined,
            new Promise<Reply>((resolve) => (settle = resolve)),
        ]);
        const auth = resolver();
        const refused = (await auth.authorization()) as string;
        elapse(60_000);
        auth.invalidate?.(refused);
        const calls = [auth.authorization(), auth.authorization(), auth.authorization()];
        await exchangesReach(exchanges, 2);
        settle(granted('ghs_syntheticexchange2'));
        expect(await Promise.all(calls)).toEqual(Array(3).fill('Bearer ghs_syntheticexchange2'));
        expect(exchanges).toHaveLength(2);
    });

    // A refresh, once a refusal asks for it, stands until a read that skipped the cache succeeds.
    // A read already under way when the refusal landed did not skip it on the refusal's behalf, so
    // its answer does not clear the request — even here, where the SDK cache had lapsed and that
    // read was minting a token of its own, so the refresh costs an exchange the cache did not need.
    // Pinned so that trading the exchange away is a decision rather than an accident.
    it('keeps the refresh a refusal asked for when a read already under way comes back with another bearer', async () => {
        let settle: (reply: Reply) => void = () => {};
        const exchanges = tokenEndpoint([
            undefined,
            new Promise<Reply>((resolve) => (settle = resolve)),
        ]);
        // The pending read is shared module-wide, so a failed assertion must not leave it held.
        onTestFinished(() => settle(granted('ghs_syntheticexchange2')));
        const auth = resolver();
        const refused = (await auth.authorization()) as string;
        // Past the SDK's 59-minute cache entry (`dist-node/index.js:43-50`): the next read exchanges.
        elapse(59 * 60_000);
        const underway = auth.authorization();
        await exchangesReach(exchanges, 2);
        auth.invalidate?.(refused);
        settle(granted('ghs_syntheticexchange2'));
        expect(await underway).toBe('Bearer ghs_syntheticexchange2');
        // The refresh is still owed, and the read that pays for it is the one that clears it.
        expect(await auth.authorization()).toBe('Bearer ghs_syntheticexchange3');
        expect(exchanges).toHaveLength(3);
        expect(await auth.authorization()).toBe('Bearer ghs_syntheticexchange3');
        expect(exchanges).toHaveLength(3);
    });
});

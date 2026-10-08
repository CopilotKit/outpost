import { describe, expect, it, vi } from 'vitest';
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

    it('authorizes evidence requests with an installation token narrowed to contents:read', async () => {
        const { create, auth } = fakeAppAuth();
        const resolver = githubEvidenceAuthFromEnv(CREDENTIALS, create);
        expect(await resolver.authorization()).toBe(`Bearer ${TOKEN}`);
        expect(auth).toHaveBeenCalledWith({
            type: 'installation',
            installationId: 7890,
            permissions: { contents: 'read' },
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

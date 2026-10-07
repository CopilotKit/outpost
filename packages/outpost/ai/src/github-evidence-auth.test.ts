import { describe, expect, it, vi } from 'vitest';
import {
    GitHubEvidenceAuthError,
    anonymousGitHubEvidenceAuth,
    githubEvidenceAuthFromEnv,
    githubEvidenceHeaders,
    type InstallationTokenFactory,
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
    onAuth: (options: Record<string, unknown>) => Promise<{ token: string }> = async () => ({
        token: TOKEN,
    }),
) {
    const auth = vi.fn(onAuth);
    const create = vi.fn<InstallationTokenFactory>(() => auth as never);
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
});

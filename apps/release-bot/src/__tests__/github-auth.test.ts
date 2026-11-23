import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appJwt, githubToken, resetGitHubAuth } from '../github-auth.js';

const ORIGINAL_FETCH = globalThis.fetch;
const VARIABLES = ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID', 'GITHUB_TOKEN'];

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

type Call = { url: string; init: RequestInit };

function serveToken(status = 200, failure: unknown = {}) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', (input: string | URL, init: RequestInit) => {
        calls.push({ url: String(input), init });
        const body =
            status === 200
                ? { token: 'ghs_minted', expires_at: new Date(Date.now() + 3600_000).toISOString() }
                : failure;
        return Promise.resolve(new Response(JSON.stringify(body), { status }));
    });
    return calls;
}

describe('githubToken', () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const name of VARIABLES) {
            saved[name] = process.env[name];
            delete process.env[name];
        }
        resetGitHubAuth();
    });

    afterEach(() => {
        vi.stubGlobal('fetch', ORIGINAL_FETCH);
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it('mints an installation token from the App variables, asking for metadata only', async () => {
        process.env.GITHUB_APP_ID = '123';
        process.env.GITHUB_PRIVATE_KEY = PEM;
        process.env.GITHUB_INSTALLATION_ID = '456';
        process.env.GITHUB_TOKEN = 'ghp_dead';
        const calls = serveToken();

        await expect(githubToken()).resolves.toBe('ghs_minted');

        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('https://api.github.com/app/installations/456/access_tokens');
        expect(calls[0]!.init.method).toBe('POST');
        expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
            permissions: { metadata: 'read' },
        });
        const auth = (calls[0]!.init.headers as Record<string, string>).Authorization;
        const [header, payload, signature] = auth!.replace('Bearer ', '').split('.');
        const verify = createVerify('RSA-SHA256');
        verify.update(`${header}.${payload}`);
        expect(verify.verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
        expect(JSON.parse(Buffer.from(payload!, 'base64url').toString()).iss).toBe('123');
    });

    it('reuses the token for the rest of the run', async () => {
        process.env.GITHUB_APP_ID = '123';
        process.env.GITHUB_PRIVATE_KEY = PEM;
        process.env.GITHUB_INSTALLATION_ID = '456';
        const calls = serveToken();

        await githubToken();
        await githubToken();

        expect(calls).toHaveLength(1);
    });

    it('accepts a key whose newlines arrive escaped', async () => {
        process.env.GITHUB_APP_ID = '123';
        process.env.GITHUB_PRIVATE_KEY = PEM.replace(/\n/g, '\\n');
        process.env.GITHUB_INSTALLATION_ID = '456';
        serveToken();

        await expect(githubToken()).resolves.toBe('ghs_minted');
    });

    it('names the missing App variable rather than falling back to GITHUB_TOKEN', async () => {
        process.env.GITHUB_APP_ID = '123';
        process.env.GITHUB_INSTALLATION_ID = '456';
        process.env.GITHUB_TOKEN = 'ghp_dead';

        await expect(githubToken()).rejects.toThrow(/^GITHUB_PRIVATE_KEY is not set/);
    });

    it('falls back to GITHUB_TOKEN when no App variable is set', async () => {
        process.env.GITHUB_TOKEN = 'ghp_local';
        await expect(githubToken()).resolves.toBe('ghp_local');
    });

    it('reports nothing configured as a missing App id', async () => {
        await expect(githubToken()).rejects.toThrow(/^GITHUB_APP_ID is not set/);
    });

    it('surfaces a refused exchange with its status', async () => {
        process.env.GITHUB_APP_ID = '123';
        process.env.GITHUB_PRIVATE_KEY = PEM;
        process.env.GITHUB_INSTALLATION_ID = '456';
        serveToken(401, { message: 'A JSON web token could not be decoded' });

        await expect(githubToken()).rejects.toThrow(/^GitHub 401 minting an installation token/);
    });
});

describe('appJwt', () => {
    it('backdates iat for clock drift and stays inside the 10-minute ceiling', () => {
        const now = Date.UTC(2026, 0, 1);
        const payload = JSON.parse(
            Buffer.from(appJwt('9', PEM, now).split('.')[1]!, 'base64url').toString(),
        );
        expect(payload).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '9' });
    });
});

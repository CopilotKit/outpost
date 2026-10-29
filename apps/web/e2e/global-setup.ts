import { execFileSync } from 'node:child_process';
import { request } from '@playwright/test';
import {
    ADMIN,
    BASE_URL,
    MEMBER_PASSWORD,
    ORG_NAME,
    PENDING_INVITE,
    USERS,
    composeArgs,
} from './support';

async function expectOk(
    res: { ok(): boolean; status(): number; text(): Promise<string> },
    what: string,
) {
    if (!res.ok()) throw new Error(`${what} failed: ${res.status()} ${await res.text()}`);
}

export default async function globalSetup(): Promise<void> {
    if (!process.env.OUTPOST_E2E_IMAGE) {
        throw new Error(
            'Set OUTPOST_E2E_IMAGE to a locally built apps/web image tag (see e2e/support.ts).',
        );
    }
    execFileSync('docker', [...composeArgs, 'down', '-v', '--remove-orphans'], {
        stdio: 'inherit',
    });
    execFileSync(
        'docker',
        [
            ...composeArgs,
            'up',
            '-d',
            '--no-build',
            '--wait',
            '--wait-timeout',
            '180',
            'postgres',
            'mailpit',
            'web',
        ],
        { stdio: 'inherit' },
    );

    const api = await request.newContext({ baseURL: BASE_URL });

    await expectOk(
        await api.post('/api/setup', {
            data: {
                orgName: ORG_NAME,
                orgEmail: 'org@e2e.test',
                name: 'E2E Admin',
                email: ADMIN.email,
                password: ADMIN.password,
                confirmPassword: ADMIN.password,
            },
        }),
        'setup',
    );

    // Sign the admin in through NextAuth's own credentials endpoint.
    const { csrfToken } = (await (await api.get('/api/auth/csrf')).json()) as { csrfToken: string };
    await expectOk(
        await api.post('/api/auth/callback/credentials', {
            form: {
                csrfToken,
                email: ADMIN.email,
                password: ADMIN.password,
                json: 'true',
                callbackUrl: `${BASE_URL}/dashboard`,
            },
        }),
        'admin sign-in',
    );
    await api.get('/dashboard'); // the middleware sets the csrf cookie on this response
    const csrf = (await api.storageState()).cookies.find((c) => c.name === 'csrf')?.value;
    if (!csrf) throw new Error('No csrf cookie after loading /dashboard');

    for (const email of [...Object.values(USERS), PENDING_INVITE]) {
        const invite = await api.post('/api/team/invite', {
            headers: { 'X-CSRF-Token': csrf },
            data: { email, role: 'MEMBER' },
        });
        await expectOk(invite, `invite ${email}`);
        if (email === PENDING_INVITE) continue;
        const { inviteUrl } = (await invite.json()) as { inviteUrl: string };
        const token = new URL(inviteUrl).searchParams.get('token');
        await expectOk(
            await api.post('/api/team/invite/accept', {
                data: {
                    token,
                    name: email.split('@')[0],
                    password: MEMBER_PASSWORD,
                    confirmPassword: MEMBER_PASSWORD,
                },
            }),
            `accept ${email}`,
        );
    }
    await api.dispose();
}

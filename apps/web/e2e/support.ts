import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext } from '@playwright/test';

/**
 * Build the image under test from the repo root, then run the spec with its tag:
 *
 *   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_AUTH_PROVIDER=credentials -t outpost-web:e2e-branch .
 *   (cd apps/web && OUTPOST_E2E_IMAGE=outpost-web:e2e-branch pnpm e2e)
 *
 * E2E_KEEP=1 leaves the Compose stack running after the run, for debugging.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

// Own ports and project, never the dev stack's (see docker-compose.e2e.yml).
export const BASE_URL = 'http://localhost:3100';
const MAILPIT = 'http://localhost:18025';

export const composeArgs = [
    'compose',
    '-p',
    'outpost-e2e',
    '--project-directory',
    repoRoot,
    '-f',
    path.join(here, 'docker-compose.e2e.yml'),
];

export const ADMIN = { email: 'admin@e2e.test', password: 'admin-pass-1' };
export const MEMBER_PASSWORD = 'member-pass-1';
/** One member per test, so a failed test cannot change another test's starting state. */
export const USERS = {
    selfService: 'self@e2e.test',
    expiry: 'expiry@e2e.test',
    profile: 'profile@e2e.test',
    adminSend: 'adminsend@e2e.test',
} as const;
export const PENDING_INVITE = 'pending@e2e.test';
export const ORG_NAME = 'E2E Org';

export interface MailSummary {
    ID: string;
    Subject: string;
    To: Array<{ Address: string }>;
}

export interface MailMessage {
    ID: string;
    Subject: string;
    Text: string;
    HTML: string;
}

export function newContext(browser: Browser): Promise<BrowserContext> {
    return browser.newContext({ baseURL: BASE_URL });
}

export async function messagesTo(address: string): Promise<MailSummary[]> {
    const res = await fetch(`${MAILPIT}/api/v1/messages?limit=500`);
    const body = (await res.json()) as { messages: MailSummary[] };
    return body.messages.filter((m) =>
        m.To.some((t) => t.Address.toLowerCase() === address.toLowerCase()),
    );
}

/** Poll Mailpit, bounded, for a message to `address` whose subject contains `subject`. */
export async function waitForMail(
    address: string,
    subject: string,
    timeoutMs = 10_000,
): Promise<MailMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const match = (await messagesTo(address)).find((m) => m.Subject.includes(subject));
        if (match) {
            return (await (
                await fetch(`${MAILPIT}/api/v1/message/${match.ID}`)
            ).json()) as MailMessage;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
        `No email to ${address} with subject containing "${subject}" within ${timeoutMs} ms`,
    );
}

export function resetLinkFrom(mail: MailMessage): string {
    const match = mail.Text.match(/http:\/\/localhost:3100\/reset-password#token=[0-9a-f]+/);
    if (!match) throw new Error('No reset link in the email text');
    return match[0];
}

/** Run one SQL statement in the e2e Postgres container and return its output. */
export function sql(query: string): string {
    return execFileSync(
        'docker',
        [
            ...composeArgs,
            'exec',
            '-T',
            'postgres',
            'psql',
            '-U',
            'outpost',
            '-d',
            'outpost',
            '-tAc',
            query,
        ],
        { encoding: 'utf8' },
    ).trim();
}

export async function signIn(
    browser: Browser,
    email: string,
    password: string,
): Promise<BrowserContext> {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto('/login');
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/dashboard');
    await page.close();
    return context;
}

/**
 * Status of GET /api/profile for this context's session. Redirects are not followed: with no
 * session the middleware answers 307 to /login, and following it would read /login's 200.
 */
export async function profileStatus(context: BrowserContext): Promise<number> {
    return (await context.request.get('/api/profile', { maxRedirects: 0 })).status();
}

/** The double-submit CSRF header; the middleware sets the `csrf` cookie on any page load. */
export async function csrfHeader(context: BrowserContext): Promise<Record<string, string>> {
    const value = (await context.cookies()).find((c) => c.name === 'csrf')?.value;
    if (!value) throw new Error('No csrf cookie: load a page in this context first');
    return { 'X-CSRF-Token': value };
}

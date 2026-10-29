/**
 * requireTransport and trackLinks (outpost#206). The postmark module is mocked so the
 * TrackLinks mapping inside createPostmarkTransport is observable; vi.mock intercepts
 * the factory's dynamic import().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPostmarkSendEmail, mockSendMail, brokenPackages } = vi.hoisted(() => ({
    mockPostmarkSendEmail: vi.fn(),
    mockSendMail: vi.fn(),
    // A package named here throws on first access to its exports, which the transport
    // factory catches in the same block as a failed import() (outpost#206).
    brokenPackages: new Set<string>(),
}));

function loadOrThrow(pkg: string): void {
    if (brokenPackages.has(pkg)) throw new Error(`Cannot find package '${pkg}'`);
}

vi.mock('postmark', () => ({
    get ServerClient() {
        loadOrThrow('postmark');
        return class {
            sendEmail = mockPostmarkSendEmail;
        };
    },
    get Models() {
        loadOrThrow('postmark');
        return { LinkTrackingOptions: { None: 'None' } };
    },
}));
vi.mock('nodemailer', () => ({
    get createTransport() {
        loadOrThrow('nodemailer');
        return () => ({ sendMail: mockSendMail });
    },
}));

import { sendEmail } from '../sender.js';
import type { EmailSendOptions, EmailTransport } from '../sender.js';

const context = {
    org: { name: 'Acme', email: 'noreply@acme.test' },
    member: { name: 'A', email: 'a@acme.test' },
};

// Every test starts with no transport configured, whatever the ambient environment
// holds (an exported POSTMARK_SERVER_TOKEN would otherwise route the SMTP test to
// Postmark), and the original values are put back afterwards.
const TRANSPORT_ENV = [
    'POSTMARK_SERVER_TOKEN',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_USER',
    'SMTP_PASS',
] as const;
const savedEnv: Partial<Record<(typeof TRANSPORT_ENV)[number], string>> = {};

beforeEach(() => {
    for (const key of TRANSPORT_ENV) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
});

afterEach(() => {
    vi.restoreAllMocks();
    mockPostmarkSendEmail.mockReset();
    mockSendMail.mockReset();
    for (const key of TRANSPORT_ENV) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
});

describe('sendEmail requireTransport', () => {
    it('refuses the console fallback and prints nothing', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        const result = await sendEmail({
            to: 'a@acme.test',
            template: 'welcome',
            context,
            requireTransport: true,
        });

        expect(result).toEqual({
            success: false,
            error: 'No email transport configured',
            method: 'console',
        });
        expect(log).not.toHaveBeenCalled();
    });

    it('keeps the console fallback when requireTransport is not set', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        const result = await sendEmail({ to: 'a@acme.test', template: 'welcome', context });

        expect(result).toEqual({ success: true, method: 'console' });
        expect(log).toHaveBeenCalled();
    });
});

describe('sendEmail requireTransport when the configured transport fails to load', () => {
    afterEach(() => {
        brokenPackages.clear();
    });

    it.each([
        ['postmark', 'POSTMARK_SERVER_TOKEN', 'pm-token'],
        ['nodemailer', 'SMTP_HOST', 'mailpit'],
    ] as const)(
        'names the %s load failure instead of "not configured", and prints nothing',
        async (pkg, envVar, value) => {
            process.env[envVar] = value;
            const log = vi.spyOn(console, 'log').mockImplementation(() => {});
            const err = vi.spyOn(console, 'error').mockImplementation(() => {});
            brokenPackages.add(pkg);

            const result = await sendEmail({
                to: 'a@acme.test',
                template: 'system/password-reset',
                context: {
                    ...context,
                    reset: { url: 'https://x.test/r#token=t', expiresIn: '30 minutes' },
                },
                requireTransport: true,
            });

            expect(result).toEqual({
                success: false,
                error: `Email transport configured (${envVar}) but its package failed to load`,
                method: 'console',
            });
            expect(log).not.toHaveBeenCalled();
            // The factory's diagnostic names the package and never carries the body.
            expect(err).toHaveBeenCalledTimes(1);
            expect(String(err.mock.calls[0][0])).toContain(`${envVar} is set but ${pkg}`);
            expect(JSON.stringify(err.mock.calls)).not.toContain('token=t');
        },
    );
});

describe('sendEmail trackLinks', () => {
    it('passes trackLinks to an injected transport', async () => {
        const sent: EmailSendOptions[] = [];
        const transport: EmailTransport = {
            send: async (opts) => {
                sent.push(opts);
                return { id: '1' };
            },
        };

        await sendEmail({
            to: 'a@acme.test',
            template: 'welcome',
            context,
            transport,
            trackLinks: 'None',
        });

        expect(sent[0].trackLinks).toBe('None');
    });

    it('maps trackLinks to Postmark TrackLinks None, and omits it otherwise', async () => {
        process.env.POSTMARK_SERVER_TOKEN = 'test-token';
        mockPostmarkSendEmail.mockResolvedValue({ MessageID: 'pm-1' });

        await sendEmail({ to: 'a@acme.test', template: 'welcome', context, trackLinks: 'None' });
        expect(mockPostmarkSendEmail.mock.calls[0][0]).toMatchObject({ TrackLinks: 'None' });

        await sendEmail({ to: 'a@acme.test', template: 'welcome', context });
        expect(mockPostmarkSendEmail.mock.calls[1][0].TrackLinks).toBeUndefined();
    });
});

describe('createSmtpTransport', () => {
    it('loads nodemailer through a module import and sends the full message', async () => {
        process.env.SMTP_HOST = 'mailpit';
        // A value no code path invents, so a transport that returns its own id fails.
        mockSendMail.mockResolvedValue({ messageId: '<smtp-7f3a91@mailpit.test>' });

        const result = await sendEmail({
            to: ['a@acme.test', 'b@acme.test'],
            template: 'system/password-reset',
            context: {
                org: { name: 'Acme', email: 'noreply@acme.test' },
                member: { email: 'a@acme.test' },
                reset: {
                    url: 'https://outpost.test/reset-password#token=abc',
                    expiresIn: '30 minutes',
                },
            },
            replyTo: 'support@acme.test',
        });

        expect(result).toEqual({
            success: true,
            messageId: '<smtp-7f3a91@mailpit.test>',
            method: 'smtp',
        });
        expect(mockSendMail).toHaveBeenCalledTimes(1);
        const mail = mockSendMail.mock.calls[0][0];
        expect(mail).toMatchObject({
            from: 'Acme <noreply@acme.test>',
            to: 'a@acme.test, b@acme.test',
            subject: 'Reset your Acme Outpost password',
            replyTo: 'support@acme.test',
        });
        expect(mail.html).toContain('href="https://outpost.test/reset-password#token=abc"');
        expect(mail.text).toContain('https://outpost.test/reset-password#token=abc');
    });
});

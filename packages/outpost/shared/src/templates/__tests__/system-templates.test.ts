import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../renderer.js';
import { loadFromFilesystem, listTemplateSlugs, isKnownTemplateSlug } from '../loader.js';
import { sendEmail } from '../../email/sender.js';
import type { EmailSendOptions } from '../../email/sender.js';
import type { TemplateContext } from '../types.js';

const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const url = `https://outpost.example.com/reset-password#token=${token}`;
const context = {
    org: { name: 'Acme', email: 'noreply@acme.test' },
    member: { email: 'alex@acme.test' },
    reset: { url, expiresIn: '30 minutes' },
};

describe('system templates', () => {
    it('loads both files by their subdirectory slug', () => {
        expect(loadFromFilesystem('system/password-reset')?.meta.subject).toBe(
            'Reset your {{org.name}} Outpost password',
        );
        expect(loadFromFilesystem('system/password-changed')?.meta.name).toBe('Password Changed');
    });

    it('keeps the full reset URL, fragment included, in html and text', async () => {
        const rendered = await renderTemplate('system/password-reset', context);
        expect(rendered).not.toBeNull();
        expect(rendered!.html).toContain(`href="${url}"`);
        expect(rendered!.text).toContain(url);
        expect(rendered!.subject).toBe('Reset your Acme Outpost password');
        expect(rendered!.text).toContain('30 minutes');
    });

    it('is not listed or known as an editable template', () => {
        // Matches any listed slug that looks like a reset template, so a copy placed at
        // the top level of templates/ (which WOULD be listed and overridable) fails here.
        expect(listTemplateSlugs().filter((s) => /password-(reset|changed)/.test(s))).toEqual([]);
        expect(isKnownTemplateSlug('system/password-reset')).toBe(false);
        expect(isKnownTemplateSlug('system/password-changed')).toBe(false);
    });
});

/**
 * Sends each system template through sendEmail with a capturing transport, using the
 * context shape that apps/web/src/lib/password-reset.ts builds: orgContext() gives
 * { name, email }, member is { email } only (never name), and the reset mail adds
 * { url, expiresIn: RESET_TTL_TEXT }.
 */
describe('system templates as sent', () => {
    const org = { name: 'Acme', email: 'noreply@acme.test' };
    const member = { email: 'alex@acme.test' };

    async function send(template: string, ctx: TemplateContext): Promise<EmailSendOptions> {
        const sent: EmailSendOptions[] = [];
        const result = await sendEmail({
            to: member.email,
            template,
            context: ctx,
            transport: {
                send: async (opts) => {
                    sent.push(opts);
                    return { id: 'captured' };
                },
            },
        });
        expect(result.success).toBe(true);
        expect(sent).toHaveLength(1);
        return sent[0];
    }

    it('password-reset: From, Subject, and the body that names the account and link', async () => {
        const mail = await send('system/password-reset', {
            org,
            member,
            reset: { url, expiresIn: '30 minutes' },
        });

        expect(mail.from).toBe('Acme <noreply@acme.test>');
        expect(mail.to).toEqual(['alex@acme.test']);
        expect(mail.subject).toBe('Reset your Acme Outpost password');
        for (const body of [mail.text, mail.html]) {
            expect(body).toContain('reset the password for your');
            expect(body).toContain('(alex@acme.test)');
            expect(body).toContain('expires in 30 minutes and can be used once');
        }
        expect(mail.html).toContain(`href="${url}"`);
        expect(mail.text).toContain(url);
    });

    it('password-changed: From, Subject, and the body that names the account', async () => {
        const mail = await send('system/password-changed', { org, member });

        expect(mail.from).toBe('Acme <noreply@acme.test>');
        expect(mail.to).toEqual(['alex@acme.test']);
        expect(mail.subject).toBe('Your Acme Outpost password was changed');
        for (const body of [mail.text, mail.html]) {
            expect(body).toContain('(alex@acme.test) was just changed');
            expect(body).toContain('All other sessions have been signed out.');
            expect(body).toContain('contact your Outpost admin immediately');
        }
    });

    it.each(['system/password-reset', 'system/password-changed'])(
        '%s never interpolates member.name',
        async (template) => {
            // The producers never pass a name, so a template that used one would render
            // it empty and pass the tests above. Pass a canary name to catch that.
            const canary = 'CANARY<b>name</b>';
            const mail = await send(template, {
                org,
                member: { ...member, name: canary },
                reset: { url, expiresIn: '30 minutes' },
            });
            for (const field of [mail.from, mail.subject, mail.text, mail.html]) {
                expect(field).not.toContain('CANARY');
            }
        },
    );
});

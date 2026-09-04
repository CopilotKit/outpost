import { describe, it, expect } from 'vitest';
import { sanitizePlatformMarkup, isSupportRequest } from '../text.js';

/**
 * A forum post that carries every noise source we have seen reach the docs
 * embedder verbatim: Discord markup, a pasted channel sidebar, and GitHub
 * issue-template boilerplate.
 */
const RAW_DISCORD_POST = [
    '<:copilotkit:1187213988392189962> hey <@!284920412034990081> :wave:',
    '',
    'I posted this in <#1205139168783503400> already but reposting here since <#1379082175625953370> said this is the right place.',
    '',
    'Channels',
    '# ┃welcome',
    '# ┃announcements',
    '# ┃support',
    'Voice Channels',
    '🔊 Lounge',
    '',
    '## Pre-flight Checklist',
    '- [x] I have searched existing issues',
    '- [ ] I am willing to submit a PR',
    '',
    '### ♻️ Reproduction Steps',
    '1. npx create-next-app',
    '',
    'How do I render a custom React component from a tool call? <t:1738000000:R>',
].join('\n');

describe('sanitizePlatformMarkup', () => {
    it('returns an empty string for empty input', () => {
        expect(sanitizePlatformMarkup('')).toBe('');
    });

    it('strips Discord channel, user, and role mentions', () => {
        const out = sanitizePlatformMarkup('see <#123> and ask <@!456> or <@&789>');
        expect(out).not.toMatch(/<[#@]/);
        expect(out).toContain('see');
        expect(out).toContain('and ask');
    });

    it('strips Discord custom emoji, shortcodes, and timestamps', () => {
        const out = sanitizePlatformMarkup(
            '<:ck:1187213988392189962> shipped :tada: at <t:1738000000:R> <a:spin:42>',
        );
        expect(out).toBe('shipped at');
    });

    it('keeps Slack link and channel labels while dropping the markup', () => {
        expect(sanitizePlatformMarkup('read <https://docs.copilotkit.ai|the docs>')).toBe(
            'read the docs',
        );
        expect(sanitizePlatformMarkup('ask in <#C123ABC|support>')).toBe('ask in support');
        expect(sanitizePlatformMarkup('cc <@U123ABC> <!here>')).toBe('cc');
    });

    it('drops issue-template checklists, HTML comments, and boilerplate headings', () => {
        const out = sanitizePlatformMarkup(
            [
                '<!-- please fill this in -->',
                '## Pre-flight Checklist',
                '- [x] I have searched existing issues',
                '### Reproduction Steps',
                'run the dev server',
            ].join('\n'),
        );
        expect(out).not.toContain('Pre-flight');
        expect(out).not.toContain('searched existing issues');
        expect(out).not.toContain('please fill this in');
        // Headings that carry signal survive, without their markers.
        expect(out).toContain('Reproduction Steps');
        expect(out).toContain('run the dev server');
    });

    it('drops pasted channel-sidebar rows', () => {
        const out = sanitizePlatformMarkup(RAW_DISCORD_POST);
        expect(out).not.toContain('┃welcome');
        expect(out).not.toContain('┃announcements');
        expect(out).not.toContain('🔊 Lounge');
    });

    it('leaves the reporter question intact and shrinks the body substantially', () => {
        const out = sanitizePlatformMarkup(RAW_DISCORD_POST);
        expect(out).toContain('How do I render a custom React component from a tool call?');
        expect(out.length).toBeLessThan(RAW_DISCORD_POST.length / 2);
    });

    it('leaves fenced code untouched', () => {
        const withCode = ['here:', '```ts', 'const x = a <@ b; // not a mention', '```'].join('\n');
        expect(sanitizePlatformMarkup(withCode)).toContain('const x = a <@ b; // not a mention');
    });
});

describe('isSupportRequest', () => {
    it('accepts anything with a question mark', () => {
        expect(isSupportRequest('does this work with Next.js?')).toBe(true);
    });

    it('accepts help phrasing without a question mark', () => {
        expect(isSupportRequest('I am stuck wiring up useCopilotAction')).toBe(true);
        expect(isSupportRequest('the runtime is not working after the upgrade')).toBe(true);
    });

    it('accepts error signatures', () => {
        expect(isSupportRequest('TypeError: Cannot read properties of undefined')).toBe(true);
        expect(isSupportRequest('    at handler (/app/src/index.ts:12:5)')).toBe(true);
    });

    it('rejects pure announcements', () => {
        expect(isSupportRequest('v1.10.0 is out. Release notes in the changelog.')).toBe(false);
        expect(isSupportRequest('Office hours start in 10 minutes. See you there!')).toBe(false);
    });

    it('rejects an empty or markup-only body', () => {
        expect(isSupportRequest('')).toBe(false);
        expect(isSupportRequest('<:tada:123> <@!456>')).toBe(false);
    });

    it('accepts a direct @-mention of the bot even without help phrasing', () => {
        expect(isSupportRequest('<@!999> take a look', { botUserId: '999' })).toBe(true);
        expect(isSupportRequest('<@!111> take a look', { botUserId: '999' })).toBe(false);
    });
});

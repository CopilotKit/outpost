import { describe, it, expect } from 'vitest';
import {
    isLikelySpamIssue,
    hasFencedCode,
    maxLinksToOneThirdPartyHost,
} from '../lib/spam-filter.js';

/**
 * Shaped after the 2026-09-10 campaign: ~3.3 KB of marketing prose, no code,
 * the same third-party host linked over and over.
 */
function spamBody(host = '1rank.app', links = 8): string {
    const para =
        'Search visibility is the difference between a business that gets found and one ' +
        'that does not. Modern buyers start with a query, and the page they click is the ' +
        'page that answers it fastest. ';
    const linked = Array.from(
        { length: links },
        (_, i) => `Read more at [our guide ${i}](https://${host}/guide-${i}). `,
    ).join('');
    let body = linked;
    while (body.length < 3300) body += para;
    return body;
}

/** A long, link-heavy, genuinely useful bug report — the class that must survive. */
function bugReportBody(): string {
    return [
        '### Reproduction',
        '',
        'Repro repo: https://github.com/someone/repro',
        'Related: https://github.com/CopilotKit/CopilotKit/issues/1',
        'Docs I followed: https://docs.copilotkit.ai/quickstart',
        'Upstream bug: https://github.com/langchain-ai/langgraph/issues/9',
        'Stackblitz: https://stackblitz.com/edit/a',
        'Sandbox: https://codesandbox.io/s/b',
        '',
        '```ts',
        'const { visibleMessages } = useCopilotChat();',
        'console.log(visibleMessages);',
        '```',
        '',
        'x'.repeat(3000),
    ].join('\n');
}

describe('maxLinksToOneThirdPartyHost', () => {
    it('counts repeats of the same third-party host', () => {
        expect(maxLinksToOneThirdPartyHost('a https://1rank.app/x b https://1rank.app/y')).toBe(2);
    });

    it('does not count our own hosts or GitHub, at any subdomain', () => {
        const body = [
            'https://github.com/a',
            'https://github.com/b',
            'https://raw.githubusercontent.com/c',
            'https://docs.copilotkit.ai/d',
            'https://copilotkit.ai/e',
            'http://localhost:3000/f',
        ].join(' ');
        expect(maxLinksToOneThirdPartyHost(body)).toBe(0);
    });

    it('normalises www. and a port so one host is not counted as three', () => {
        expect(
            maxLinksToOneThirdPartyHost(
                'https://www.1rank.app/a https://1rank.app/b https://1rank.app:443/c',
            ),
        ).toBe(3);
    });

    it('returns the MAX for one host, not the total across hosts', () => {
        // Six links, but spread three ways — nothing is being advertised.
        const body =
            'https://a.io/1 https://a.io/2 https://b.io/1 https://b.io/2 https://c.io/1 https://c.io/2';
        expect(maxLinksToOneThirdPartyHost(body)).toBe(2);
    });
});

describe('hasFencedCode', () => {
    it('is true for an opened-and-closed block', () => {
        expect(hasFencedCode('text\n```ts\ncode\n```\n')).toBe(true);
    });

    it('is false for a single stray fence', () => {
        expect(hasFencedCode('text ``` more text')).toBe(false);
    });
});

describe('isLikelySpamIssue', () => {
    it('flags the campaign shape: untrusted, long, no code, one host repeated', () => {
        expect(isLikelySpamIssue({ body: spamBody(), authorAssociation: 'NONE' })).toBe(true);
    });

    // Every AND term gets its own negative case: a gate that silently eats real
    // reports is worse than the spam it was built for, because nothing on the
    // issue records that a decision was made.
    it('never flags a trusted author, whatever they write', () => {
        for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR']) {
            expect(isLikelySpamIssue({ body: spamBody(), authorAssociation: assoc })).toBe(false);
        }
    });

    it('matches author_association case-insensitively', () => {
        expect(isLikelySpamIssue({ body: spamBody(), authorAssociation: 'member' })).toBe(false);
    });

    it('does not flag a long, link-heavy bug report that carries a repro', () => {
        expect(isLikelySpamIssue({ body: bugReportBody(), authorAssociation: 'NONE' })).toBe(false);
    });

    it('does not flag a short body even if it is all links', () => {
        expect(
            isLikelySpamIssue({ body: spamBody().slice(0, 1200), authorAssociation: 'NONE' }),
        ).toBe(false);
    });

    it('does not flag a long body whose links are spread across hosts', () => {
        const body =
            Array.from({ length: 12 }, (_, i) => `https://host${i}.example/x `).join('') +
            'y'.repeat(3000);
        expect(isLikelySpamIssue({ body, authorAssociation: 'NONE' })).toBe(false);
    });

    it('does not flag a long body that only links GitHub and our docs', () => {
        const body =
            Array.from(
                { length: 12 },
                (_, i) => `https://github.com/CopilotKit/x/issues/${i} `,
            ).join('') + 'y'.repeat(3000);
        expect(isLikelySpamIssue({ body, authorAssociation: 'NONE' })).toBe(false);
    });

    it('handles an empty or missing body without throwing', () => {
        expect(isLikelySpamIssue({ body: '', authorAssociation: 'NONE' })).toBe(false);
        expect(isLikelySpamIssue({ body: null, authorAssociation: 'NONE' })).toBe(false);
        expect(isLikelySpamIssue({ body: undefined, authorAssociation: undefined })).toBe(false);
    });

    it('treats a missing author_association as untrusted, not as trusted', () => {
        // Fail closed on the spam side: an absent field must not become a bypass.
        expect(isLikelySpamIssue({ body: spamBody(), authorAssociation: null })).toBe(true);
    });
});

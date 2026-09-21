import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    supportReplyDetails,
    supportReplySchema,
    supportReplyText,
    validateSupportReply,
    type SupportReply,
} from './support-reply.js';
import type { SearchResult } from './types.js';

const sourceUrl = 'https://docs.copilotkit.ai/reference/provider';
const quote = 'Configure the provider with your runtime URL.';
const sources: SearchResult[] = [
    {
        title: 'Provider configuration',
        content: `12: ${quote}\n13: Mount the provider above your chat.`,
        sourceUrl,
        score: 0.95,
    },
];

function reply(overrides: Partial<SupportReply> = {}): SupportReply {
    return {
        decision: 'answer',
        summary: 'Configure the provider with your runtime URL, then mount your chat inside it.',
        details: 'The provider supplies the connection to your runtime.',
        apiVersion: 'v2',
        appliesTo: 'React applications using the provider.',
        evidence: [{ sourceUrl, quote }],
        handoffReason: '',
        ...overrides,
    };
}

function route(overrides: Partial<SupportReply> = {}): SupportReply {
    return reply({
        decision: 'route',
        summary: 'An engineer needs to inspect your runtime configuration.',
        details: '',
        evidence: [],
        appliesTo: '',
        apiVersion: 'unknown',
        handoffReason: 'The retrieved sources do not cover this runtime error.',
        ...overrides,
    });
}

function replyWithDeprecatedSource(marker: 'url' | 'title', overrides: Partial<SupportReply> = {}) {
    const deprecatedUrl =
        marker === 'url'
            ? 'https://docs.copilotkit.ai/v1-deprecated/reference/provider'
            : sourceUrl;
    return {
        value: reply({ evidence: [{ sourceUrl: deprecatedUrl, quote }], ...overrides }),
        retrieved: sources.map((source) => ({
            ...source,
            sourceUrl: deprecatedUrl,
            title: marker === 'title' ? 'V1-DEPRECATED provider configuration' : source.title,
        })),
    };
}

describe('support reply contract', () => {
    it('exposes a strict structured-output schema with every field required', () => {
        const schema = z.toJSONSchema(supportReplySchema);
        expect(schema.required).toEqual([
            'decision',
            'summary',
            'details',
            'apiVersion',
            'appliesTo',
            'evidence',
            'handoffReason',
        ]);
        expect(schema.additionalProperties).toBe(false);
        expect(() => validateSupportReply({ ...reply(), invented: true }, sources)).toThrow();
        expect(() => validateSupportReply({ summary: 'Missing fields' }, sources)).toThrow();
    });

    it('accepts a quoted passage after whitespace and source line-prefix normalization', () => {
        const value = reply({
            evidence: [{ sourceUrl, quote: 'Configure the provider\nwith your runtime URL.' }],
        });
        expect(validateSupportReply(value, sources)).toEqual(value);
    });

    it.each(['answer', 'partial'] as const)('requires evidence for a %s', (decision) => {
        expect(() => validateSupportReply(reply({ decision, evidence: [] }), sources)).toThrow(
            /evidence/i,
        );
    });

    it.each([
        { sourceUrl: 'https://docs.copilotkit.ai/invented', quote },
        { sourceUrl, quote: 'A fabricated statement absent from the source.' },
        { sourceUrl, quote: 'the' },
    ])('rejects unsupported evidence %#', (evidence) => {
        expect(() => validateSupportReply(reply({ evidence: [evidence] }), sources)).toThrow(
            /evidence|quote|source/i,
        );
    });

    it.each([
        ['answer', 'url'],
        ['answer', 'title'],
        ['partial', 'url'],
        ['partial', 'title'],
    ] as const)('rejects a v2 %s citing a v1-deprecated source %s', (decision, marker) => {
        const { value, retrieved } = replyWithDeprecatedSource(marker, { decision });
        expect(() => validateSupportReply(value, retrieved)).toThrow(/v2.*v1-deprecated/i);
    });

    it.each(['v1', 'unknown'] as const)(
        'allows v1-deprecated evidence for a %s reply',
        (apiVersion) => {
            const { value, retrieved } = replyWithDeprecatedSource('url', { apiVersion });
            expect(validateSupportReply(value, retrieved)).toEqual(value);
        },
    );

    it('does not reject a v2 answer because an uncited retrieved source is deprecated', () => {
        const { retrieved } = replyWithDeprecatedSource('url');
        expect(validateSupportReply(reply(), [...sources, ...retrieved])).toEqual(reply());
    });

    it.each([
        '',
        'word '.repeat(81),
        'First paragraph.\n\nSecond paragraph.',
        '```ts\nconst a = 1;\n```',
        '# A heading',
        '- A list item',
        'Heading\n===',
    ])('rejects a summary that is not one concise paragraph %#', (summary) => {
        expect(() => validateSupportReply(reply({ summary }), sources)).toThrow(/summary/i);
    });

    it('caps the detailed answer independently of the summary', () => {
        expect(() =>
            validateSupportReply(reply({ details: 'word '.repeat(1201) }), sources),
        ).toThrow(/details/i);
    });

    it('accepts a short route with no technical detail or evidence', () => {
        expect(validateSupportReply(route(), [])).toEqual(route());
    });

    it.each([{ handoffReason: '' }, { summary: 'word '.repeat(61) }])(
        'requires a concise, reasoned route %#',
        (overrides) => {
            expect(() => validateSupportReply(route(overrides), [])).toThrow(/summary|handoff/i);
        },
    );

    it.each([
        '[documentation](https://docs.copilotkit.ai/invented)',
        'Read https://docs.copilotkit.ai/invented.',
        '<https://docs.copilotkit.ai/invented>',
        '[documentation][guide]\n\n[guide]: https://docs.copilotkit.ai/invented',
        '[documentation](javascript:alert(1))',
        '[documentation](//example.com/steal)',
        '[documentation](#invented)',
        'Read www.example.com/steal.',
        `[documentation](${sourceUrl}!)`,
        `[documentation][guide]\n\n[guide]: ${sourceUrl}!`,
        `<${sourceUrl}!>`,
    ])('rejects invented or unsafe prose links %#', (details) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(/link|url/i);
    });

    it.each([
        `[documentation](${sourceUrl}#runtime)`,
        `Read ${sourceUrl}.`,
        `<${sourceUrl}>`,
        `[documentation][guide]\n\n[guide]: ${sourceUrl}`,
    ])('allows retrieved links and anchors in prose %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    it('rejects a v2 prose citation to deprecated material omitted from its evidence', () => {
        const { retrieved } = replyWithDeprecatedSource('url');
        const details =
            '[Legacy provider](https://docs.copilotkit.ai/v1-deprecated/reference/provider)';
        expect(() => validateSupportReply(reply({ details }), [...sources, ...retrieved])).toThrow(
            /evidence|link|url/i,
        );
    });

    it.each(['summary', 'details'] as const)(
        'requires a second source cited in %s to have its own evidence',
        (field) => {
            const otherUrl = 'https://docs.copilotkit.ai/reference/runtime';
            const retrieved = [
                ...sources,
                ...sources.map((source) => ({ ...source, sourceUrl: otherUrl })),
            ];
            const citation = `Read the [runtime guide](${otherUrl}).`;
            expect(() => validateSupportReply(reply({ [field]: citation }), retrieved)).toThrow(
                /evidence|link|url/i,
            );
            const value = reply({
                [field]: citation,
                evidence: [
                    { sourceUrl, quote },
                    { sourceUrl: otherUrl, quote },
                ],
            });
            expect(validateSupportReply(value, retrieved)).toEqual(value);
        },
    );

    it.each(['summary', 'details'] as const)('accepts literal inline JSX in %s', (field) => {
        const value = reply({ [field]: 'Mount `<CopilotKit>` above `<CopilotChat>`.' });
        expect(validateSupportReply(value, sources)).toEqual(value);
    });

    it.each([
        'Use `http://localhost:4000` for local testing.',
        'Render ``<Provider label=`chat` />``.',
        'Render ``<Provider />` literal backtick``.',
        'Render `<Provider />\\`.',
        'A literal backslash \\\\`<Provider />`.',
    ])('preserves valid same-line code spans %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    it.each([
        'An unmatched opener `<script>alert(1)</script>.',
        'An escaped opener \\`<script>alert(1)</script>`.',
        'Unequal runs ``<script>alert(1)</script>`.',
        'A partial longer closer `<script>alert(1)</script>``.',
        'A safe span `<Provider />` then <script>alert(1)</script>.',
        'A paragraph boundary `literal\n\n<script>alert(1)</script>\n`.',
        'A line boundary `literal\n<script>alert(1)</script>\n`.',
        '<img title="`" src=x onerror=alert(1) data-end="`">',
    ])('does not hide raw HTML behind invalid or escaped code spans %#', (details) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(/html/i);
    });

    it.each([
        'An unmatched URL `https://example.com/steal.',
        'An escaped URL \\`https://example.com/steal`.',
        'Use `<Provider />`, then read https://example.com/steal.',
        '[guide]\n\n[guide]: `https://example.com/steal`',
        '[guide](`https://example.com/steal`)',
        '<https://example.com/`steal`>',
    ])('does not hide invented links behind invalid or non-code backticks %#', (details) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(/link|url/i);
    });

    // A link label ends at the first right bracket that is not backslash-escaped and
    // may span lines, so every shape below resolves to a clickable link in the
    // renderer even though a single-line label pattern cannot describe it.
    it.each([
        '[documentation][guide]\n\n[guide]: //example.invalid/steal',
        '[documentation][guide]\n\n[guide]: #invented',
        '[documentation][re\\]f]\n\n[re\\]f]: //example.invalid/steal',
        '[documentation][re\\]f]\n\n[re\\]f]: //docs.copilotkit.ai/reference/provider',
        '[documentation][re\\]f]\n\n[re\\]f]: <//example.invalid/steal>',
        '[documentation][re\\]f]\n\n[re\\]f]:\n//example.invalid/steal',
        '[documentation][re\\]f]\n\n[re\\]f]: #invented',
        '[re\\]f]\n\n[re\\]f]: //example.invalid/steal',
        '[documentation][a\\\\]\n\n[a\\\\]: //example.invalid/steal',
        '[documentation][re\nf]\n\n[re\nf]: //example.invalid/steal',
        '[documentation][re\nf]\n\n[re\nf]: //docs.copilotkit.ai/reference/provider',
        '[documentation][re\nf]\n\n[re\nf]: <//example.invalid/steal>',
        '[documentation][re\nf]\n\n[re\nf]:\n//example.invalid/steal',
        '[documentation][re\nf]\n\n[re\nf]: #invented',
        '[re\nf][]\n\n[re\nf]: //example.invalid/steal',
        '[documentation][a\nb\nc]\n\n[a\nb\nc]: //example.invalid/steal',
        '[documentation][a\\]b\nc]\n\n[a\\]b\nc]: //example.invalid/steal',
        '[documentation][a\\\nb]\n\n[a\\\nb]: //example.invalid/steal',
    ])('rejects a non-evidence reference definition destination %#', (details) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(/link|url/i);
    });

    // Backticks inside a reference definition are destination characters, not a code
    // span, for an escaped or multiline label just as for `[guide]: ...` above.
    it.each([
        `[re\\]f]\n\n[re\\]f]: \`${sourceUrl}\``,
        `[re\nf]\n\n[re\nf]: \`${sourceUrl}\``,
        `[documentation][re\\]f]\n\n[re\\]f]: \`https://example.com/steal\``,
        `[documentation][re\nf]\n\n[re\nf]: \`https://example.com/steal\``,
    ])('does not hide a reference destination behind non-code backticks %#', (details) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(/link|url/i);
    });

    it.each([
        `[documentation][re\\]f]\n\n[re\\]f]: ${sourceUrl}`,
        `[documentation][re\\]f]\n\n[re\\]f]: <${sourceUrl}>`,
        `[documentation][re\\]f]\n\n[re\\]f]:\n${sourceUrl}`,
        `[documentation][re\\]f]\n\n[re\\]f]: ${sourceUrl}#runtime`,
        `[documentation][re\nf]\n\n[re\nf]: ${sourceUrl}`,
        `[documentation][re\nf]\n\n[re\nf]: <${sourceUrl}>`,
        `[documentation][re\nf]\n\n[re\nf]:\n${sourceUrl}`,
        `[documentation][re\nf]\n\n[re\nf]: ${sourceUrl}#runtime`,
        `[documentation][a\nb\nc]\n\n[a\nb\nc]: ${sourceUrl}`,
        `[documentation][a\\]b\nc]\n\n[a\\]b\nc]: ${sourceUrl}`,
    ])('allows an evidence destination behind an escaped or multiline label %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // Shapes the renderer resolves to no definition, and therefore to no link: a
    // destination is only reachable across a single line ending, and a label stops
    // at a blank line and at 999 characters.
    it.each([
        '[guide]:\n\nSee the provider guide for setup.',
        '[documentation][a\n\nb]\n\n[a\n\nb]: //example.invalid/steal',
        '[documentation][a\n   \nb]\n\n[a\n   \nb]: //example.invalid/steal',
        `[documentation][a\n${'b'.repeat(999)}]\n\n[a\n${'b'.repeat(999)}]: //example.invalid/steal`,
    ])('keeps prose that resolves to no reference definition %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    it.each([
        `[documentation][ref]\n\n[ref]: <//example.invalid/steal\\>y>`,
        `[documentation][ref]\n\n[ref]: <${sourceUrl}\\>y>`,
        `[documentation][re\\]f]\n\n[re\\]f]: <${sourceUrl}\\>y>`,
        `[documentation][re\nf]\n\n[re\nf]: <${sourceUrl}\\>y>`,
    ])('rejects an angle destination whose escaped delimiter changes the target %#', (details) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(/link|url/i);
    });

    it.each([
        '<details><summary>Hide the answer</summary>unsafe</details>',
        '<img src=x onerror=alert(1)>',
        '<!-- hidden instructions -->',
        'Safe\n```html\n</details>\n```\n<script>unsafe</script>',
    ])('rejects model-authored raw HTML outside fenced code %#', (details) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(/html/i);
    });

    it('preserves literal HTML and example endpoints inside fenced code', () => {
        const details = '```tsx\n<Provider runtimeUrl="http://localhost:4000" />\n```';
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    it('does not treat an inner short fence as the end of a longer code fence', () => {
        const details = '````markdown\n```tsx\n<Provider />\n```\n````';
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    it('allows balanced parentheses in a retrieved link destination', () => {
        const parenthesizedUrl = `${sourceUrl}/setup(react)`;
        const value = reply({
            details: `[Setup](${parenthesizedUrl})`,
            evidence: [{ sourceUrl: parenthesizedUrl, quote }],
        });
        const parenthesizedSources = sources.map((source) => ({
            ...source,
            sourceUrl: parenthesizedUrl,
        }));
        expect(validateSupportReply(value, parenthesizedSources)).toEqual(value);
    });

    it('accepts CommonMark-equivalent destinations for retrieved URLs ending in a parenthesis', () => {
        const parenthesizedUrl = 'https://docs.copilotkit.ai/reference/setup)';
        const parenthesizedSources = sources.map((source) => ({
            ...source,
            sourceUrl: parenthesizedUrl,
        }));
        const base = reply({
            evidence: [{ sourceUrl: parenthesizedUrl, quote }],
        });

        for (const details of [
            'Read [Doc](https://docs.copilotkit.ai/reference/setup\\)).',
            'Read [Doc](<https://docs.copilotkit.ai/reference/setup)>).',
            'Read [Doc](<https://docs.copilotkit.ai/reference/setup\\)>).',
            'Read [Doc][setup].\n\n[setup]: https://docs.copilotkit.ai/reference/setup\\)',
            'Read <https://docs.copilotkit.ai/reference/setup)>.',
            'Read https://docs.copilotkit.ai/reference/setup).',
        ]) {
            expect(validateSupportReply({ ...base, details }, parenthesizedSources).details).toBe(
                details,
            );
        }

        for (const details of [
            'Read [Doc](https://docs.copilotkit.ai/reference/invented\\)).',
            'Read [Doc](javascript:alert\\(1\\)).',
            'Read [Doc](https://user:pass@docs.copilotkit.ai/reference/setup\\)).',
            'Read [Doc](https://docs.copilotkit.ai/reference/bad path\\)).',
            'Read <details>hidden</details>.',
        ]) {
            expect(() => validateSupportReply({ ...base, details }, parenthesizedSources)).toThrow(
                /html|link|url/i,
            );
        }
    });

    it('keeps raw URL validation aligned after non-BMP characters before Markdown links', () => {
        const parenthesizedUrl = 'https://docs.copilotkit.ai/reference/setup)';
        const parenthesizedSources = sources.map((source) => ({
            ...source,
            sourceUrl: parenthesizedUrl,
        }));
        const base = reply({
            evidence: [{ sourceUrl: parenthesizedUrl, quote }],
        });

        const details = '🔎🔎🔎🔎🔎🔎🔎🔎 [Doc](https://docs.copilotkit.ai/reference/setup\\)).';
        expect(validateSupportReply({ ...base, details }, parenthesizedSources).details).toBe(
            details,
        );

        expect(() =>
            validateSupportReply(
                {
                    ...base,
                    details: `${details} https://docs.copilotkit.ai/reference/invented.`,
                },
                parenthesizedSources,
            ),
        ).toThrow(/link|url/i);
    });

    it('accepts segment-encoded GitHub blob source paths without allowing raw whitespace URLs', () => {
        const encodedBlobUrl =
            'https://github.com/CopilotKit/CopilotKit/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/docs/My%20Guide.md';
        const encodedSources = sources.map((source) => ({
            ...source,
            sourceUrl: encodedBlobUrl,
        }));
        const value = reply({
            details: `[Guide](${encodedBlobUrl})`,
            evidence: [{ sourceUrl: encodedBlobUrl, quote }],
        });
        expect(validateSupportReply(value, encodedSources)).toEqual(value);

        const rawSpaceUrl = encodedBlobUrl.replace('My%20Guide.md', 'My Guide.md');
        expect(() =>
            validateSupportReply(
                reply({ evidence: [{ sourceUrl: rawSpaceUrl, quote }] }),
                encodedSources.map((source) => ({ ...source, sourceUrl: rawSpaceUrl })),
            ),
        ).toThrow(/evidence|source/i);
    });

    it('rejects an unclosed code fence that would swallow the generated footer', () => {
        expect(() =>
            validateSupportReply(reply({ details: '```tsx\n<Provider />' }), sources),
        ).toThrow(/fence/i);
    });

    it.each(['summary', 'appliesTo'] as const)('also checks %s for HTML injection', (field) => {
        expect(() =>
            validateSupportReply(reply({ [field]: '<details>Injected</details>' }), sources),
        ).toThrow(/html|summary/i);
    });

    it.each([
        'Needs review for https://github.com/CopilotKit/CopilotKit/issues/1.',
        'Validator rejected model output containing literal <details> markup.',
    ])('preserves private handoff diagnostics without public prose validation %#', (reason) => {
        const value = route({ handoffReason: reason });

        expect(validateSupportReply(value, [])).toEqual(value);
        expect(supportReplyText(value)).not.toContain(reason);
        expect(supportReplyDetails(value)).not.toContain(reason);
    });

    it.each([
        {
            field: 'summary',
            value: 'Needs review for https://github.com/CopilotKit/CopilotKit/issues/1.',
            error: /link|url/i,
        },
        {
            field: 'details',
            value: 'Needs review for https://github.com/CopilotKit/CopilotKit/issues/1.',
            error: /link|url/i,
        },
        {
            field: 'appliesTo',
            value: 'Needs review for https://github.com/CopilotKit/CopilotKit/issues/1.',
            error: /link|url/i,
        },
        { field: 'summary', value: '<details>Injected</details>', error: /html|summary/i },
        { field: 'details', value: '<details>Injected</details>', error: /html/i },
        { field: 'appliesTo', value: '<details>Injected</details>', error: /html/i },
    ] as const)('keeps public prose validation strict for $field diagnostics', (testCase) => {
        expect(() =>
            validateSupportReply(reply({ [testCase.field]: testCase.value }), sources),
        ).toThrow(testCase.error);
    });
});

describe('support reply rendering helpers', () => {
    it('gives linter text the actual answer and source citations', () => {
        const text = supportReplyText(reply());
        expect(text.startsWith(reply().summary)).toBe(true);
        expect(text).toContain(reply().details);
        expect(text).toContain(sourceUrl);
        expect(text).not.toContain(quote);
    });

    it('renders applicability, API version, and unique evidence links without repeating the summary', () => {
        const details = supportReplyDetails(
            reply({
                evidence: [
                    { sourceUrl, quote },
                    { sourceUrl, quote },
                ],
            }),
        );
        expect(details).toContain('**Applies to:** React applications using the provider.');
        expect(details).toContain('**API version:** v2');
        expect(details.match(/https:\/\//g)).toHaveLength(1);
        expect(details).not.toContain(reply().summary);
        expect(details).not.toContain(quote);
    });

    it('escapes markdown structure in applicability metadata', () => {
        expect(supportReplyDetails(reply({ appliesTo: '*React* [apps]' }))).toContain(
            '\\*React\\* \\[apps\\]',
        );
    });

    it('never renders route metadata, drafts, or internal handoff reasons', () => {
        const value = route({
            details: 'Internal draft',
            appliesTo: 'Internal applicability',
            evidence: [{ sourceUrl, quote }],
        });
        expect(supportReplyDetails(value)).toBe('');
        expect(supportReplyText(value)).toBe(value.summary);
    });
});

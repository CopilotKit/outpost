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

/** The same reply and retrieval set, grounded on one chosen evidence URL. */
function grounded(evidenceUrl: string, details: string) {
    return {
        value: reply({ details, evidence: [{ sourceUrl: evidenceUrl, quote }] }),
        retrieved: sources.map((source) => ({ ...source, sourceUrl: evidenceUrl })),
    };
}

/** One URL whose query carries an '&', and the character-reference spelling of it. */
const ampersandUrl = 'https://docs.copilotkit.ai/search?a=1&b=2';
const encodedAmpersandUrl = 'https://docs.copilotkit.ai/search?a=1&amp;b=2';

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
        // GFM autolink literals: the renderer publishes a mailto: anchor for each
        // of these, so each is a destination that has to come from the evidence.
        'Contact help@example.invalid for instructions.',
        'Contact mailto:help@example.invalid for instructions.',
        'Contact xmpp:help@example.invalid for instructions.',
    ])('rejects invented or unsafe prose links %#', (details) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(/link|url/i);
    });

    // A bare `www.` literal is published with an http:// scheme, so the https://
    // spelling of the same host does not ground it and the http:// spelling does.
    it('grounds a bare www autolink against the destination the renderer publishes', () => {
        const details = 'See www.copilotkit.ai/reference/provider for the option.';
        const citing = (sourceUrl: string) => ({
            value: reply({ details, evidence: [{ sourceUrl, quote }] }),
            retrieved: sources.map((source) => ({ ...source, sourceUrl })),
        });

        const invented = citing('https://www.copilotkit.ai/reference/provider');
        expect(() => validateSupportReply(invented.value, invented.retrieved)).toThrow(/link|url/i);

        const published = citing('http://www.copilotkit.ai/reference/provider');
        expect(validateSupportReply(published.value, published.retrieved)).toEqual(published.value);
    });

    // Accept-direction controls for the same scan: this renderer linkifies no bare
    // ftp:// literal, and linkifies nothing inside code, so none of these publishes
    // a destination and none of them may be discarded as an ungrounded link.
    it.each([
        'Use ftp://example.invalid/pub for the archive.',
        'Contact `help@example.invalid` for instructions.',
        '```text\nhelp@example.invalid\n```',
    ])('keeps prose the renderer publishes no link for %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // Where a GFM autolink literal ends is the grammar's answer, not a punctuation
    // class's. An emphasis or strikethrough run closing on the address is a
    // delimiter the renderer publishes outside the anchor — every row below reaches
    // the reader as the cited evidence URL inside <strong>, <em> or <del>, recorded
    // against the app's real ReactMarkdown + remark-gfm in
    // apps/web/src/__tests__/qa-components.test.tsx. The raw-URL scan read the
    // closing run as URL characters instead, so a correctly grounded citation was
    // discarded and its reply escalated to a human.
    it.each([
        `**Read ${sourceUrl}**`,
        `*Read ${sourceUrl}*`,
        `_Read ${sourceUrl}_`,
        `__Read ${sourceUrl}__`,
        `~~Read ${sourceUrl}~~`,
        `Read ${sourceUrl}*`,
        `**${sourceUrl}**`,
        // The shape that already passed, on the other side of the same boundary:
        // here the grammar and the punctuation class happened to agree.
        `Read (${sourceUrl}).`,
    ])('keeps an evidence autolink a delimiter run closes on %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // `validateProse` has one caller, which runs it over all three public fields, so
    // the delimiters must not be read differently in the field a reply is escalated
    // over than in the one the rows above use.
    it.each(['summary', 'details', 'appliesTo'] as const)(
        'keeps an emphasized evidence autolink cited in %s',
        (field) => {
            const value = reply({ [field]: `**Read ${sourceUrl}**` });
            expect(validateSupportReply(value, sources)[field]).toBe(`**Read ${sourceUrl}**`);
        },
    );

    // The refusal the rows above must not take with them. A delimiter run around an
    // address no evidence backs changes nothing a reader can click: the renderer
    // publishes the ungrounded destination just as clickably, so each of these stays
    // refused.
    it.each([
        '**Read https://docs.copilotkit.ai/invented**',
        '__Read https://docs.copilotkit.ai/invented__',
        '~~Read https://docs.copilotkit.ai/invented~~',
        'Read https://docs.copilotkit.ai/invented*',
        '**Read www.example.invalid/steal**',
        '~~Contact help@example.invalid~~',
    ])('still refuses an ungrounded autolink a delimiter run closes on %#', (details) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(/link|url/i);
    });

    // `](` is a destination opener only where a link label closed on it. In each of
    // these the renderer publishes no anchor at all and prints the brackets as
    // ordinary punctuation, so reading every `](` as a destination discards a reply
    // whose reader would only ever have seen plain text.
    it.each([
        'The literal punctuation ](not a link) is part of this sentence.',
        'Compare a](b) and c](d) in one line.',
        'Multi\nline ](not a link) prose.',
        '> Quoted ](not a link) prose.',
        '- Item ](not a link) prose.',
        `See [docs](${sourceUrl}) and ](not a link) together.`,
    ])('keeps literal bracket punctuation that opens no link %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // The inline-code scan reads the same `](` to decide where a destination runs,
    // and a destination is not code — so a literal `](` made it skip over a code
    // span the renderer does form, leaving the example URL inside it exposed to the
    // raw-URL scans as though the reader could click it.
    it.each([
        'See ](`https://example.com/steal`) here.',
        'Compare a](`https://example.com/steal`) and b in one line.',
        '> Quoted ](`https://example.com/steal`) prose.',
        '- Item ](`https://example.com/steal`) prose.',
        `See [docs](${sourceUrl}) and ](\`https://example.com/steal\`) together.`,
        // The same skipped span reached the raw HTML check too. The rule there is
        // unchanged — HTML is allowed inside code — this span is now seen as the
        // code it is rendered as.
        'See ](`<script>alert(1)</script>`) here.',
    ])('keeps a code span that no link label opened %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // The two spellings either side of it, which already passed: the same span with
    // no bracket before it, and one the bracket cannot reach across a space.
    it.each([
        'See (`https://example.com/steal`) here.',
        'See ] (`https://example.com/steal`) here.',
    ])('keeps the code spans the literal bracket is neighboured by %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // The same punctuation does open a link in each of these — an array subscript
    // the renderer linkifies, an image, an image nested in a link label, and labels
    // no single-line pattern delimits — so the destination still has to be evidence.
    it.each([
        'Array access arr[i](x) in pseudocode.',
        '![diagram](https://docs.copilotkit.ai/invented.png)',
        `[![diagram](https://cdn.example.invalid/a.png)](${sourceUrl})`,
        '[lab [nest] el](https://docs.copilotkit.ai/invented)',
        '[esc\\]aped](https://docs.copilotkit.ai/invented)',
        '[multi\nline label](https://docs.copilotkit.ai/invented)',
        `See [docs](${sourceUrl}) and [more](https://docs.copilotkit.ai/invented).`,
    ])('still grounds a destination a real link label opened %#', (details) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(/link|url/i);
    });

    // Every destination the link grammar accounts for must stay masked from the raw
    // URL scans below it, including one nested inside another link's label, or the
    // same evidence URL is scanned again in a spelling those scans cannot accept.
    it.each([
        `[![diagram](${sourceUrl})](${sourceUrl})`,
        `[docs](  ${sourceUrl}  )`,
        `[docs](${sourceUrl} "the provider reference")`,
    ])('masks a nested, padded or titled destination from the raw URL scans %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    it.each([
        `[documentation](${sourceUrl}#runtime)`,
        `Read ${sourceUrl}.`,
        `<${sourceUrl}>`,
        `[documentation][guide]\n\n[guide]: ${sourceUrl}`,
        `[documentation][guide]\n\n[guide]: <${sourceUrl}>`,
        `[documentation][guide]\n\n   [guide]: ${sourceUrl}`,
    ])('allows retrieved links and anchors in prose %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // A '&' in a query is the character a model most often writes as `&amp;`, and
    // the renderer resolves that reference before publishing the href: every
    // spelling below reaches the reader as `…/search?a=1&b=2`. The definition form
    // arrived from the parser already decoded and was accepted; the inline form was
    // read as spelled and discarded, so one published href had two spellings on
    // opposite sides of the evidence check. Recorded in 00-renderer-probe.log (the
    // app's ReactMarkdown + remark-gfm) and 01-grammar-probe.log (this parser).
    it.each([
        `See [docs](${encodedAmpersandUrl}).`,
        `See [docs](<${encodedAmpersandUrl}>).`,
        `![diagram](${encodedAmpersandUrl})`,
        `See [docs][d].\n\n[d]: ${encodedAmpersandUrl}`,
        `See [docs][d].\n\n[d]: <${encodedAmpersandUrl}>`,
        'See [docs](https://docs.copilotkit.ai/search?a=1&#38;b=2).',
        'See [docs](https://docs.copilotkit.ai/search?a=1&#x26;b=2).',
        // A backslash escape is resolved in the same place and was already decoded
        // before this change; it is the control the character-reference rows join.
        'See [docs](https://docs.copilotkit.ai/search?a=1\\&b=2).',
    ])('grounds an entity-encoded destination on the URL it decodes to %#', (details) => {
        const { value, retrieved } = grounded(ampersandUrl, details);
        expect(validateSupportReply(value, retrieved)).toEqual(value);
    });

    // `validateProse` has one caller, which runs it over all three public fields
    // and over the composed reply, so the decoding must not be specific to the
    // field the rows above use.
    it.each(['summary', 'details', 'appliesTo'] as const)(
        'decodes an entity-encoded destination cited in %s',
        (field) => {
            const value = reply({
                [field]: `See [docs](${encodedAmpersandUrl}).`,
                evidence: [{ sourceUrl: ampersandUrl, quote }],
            });
            const retrieved = sources.map((source) => ({ ...source, sourceUrl: ampersandUrl }));
            expect(validateSupportReply(value, retrieved)).toEqual(value);
        },
    );

    // The comparison is per syntax because the renderer is. An inline destination
    // and a reference definition publish the decoded URL; a CommonMark autolink and
    // a GFM autolink literal publish their address exactly as spelled, `&amp;` and
    // all. Asserting one normalization for all five would ground two of them on a
    // URL the reader never reaches. Each row is checked in both directions, so the
    // relation holds rather than the individual values.
    it.each([
        {
            syntax: 'inline destination',
            details: `See [docs](${encodedAmpersandUrl}).`,
            publishes: ampersandUrl,
        },
        {
            syntax: 'angle inline destination',
            details: `See [docs](<${encodedAmpersandUrl}>).`,
            publishes: ampersandUrl,
        },
        {
            syntax: 'reference definition',
            details: `See [docs][d].\n\n[d]: ${encodedAmpersandUrl}`,
            publishes: ampersandUrl,
        },
        {
            syntax: 'CommonMark autolink',
            details: `See <${encodedAmpersandUrl}> now.`,
            publishes: encodedAmpersandUrl,
        },
        {
            syntax: 'GFM autolink literal',
            details: `See ${encodedAmpersandUrl} now.`,
            publishes: encodedAmpersandUrl,
        },
    ])('grounds a $syntax on the destination that syntax publishes', ({ details, publishes }) => {
        const published = grounded(publishes, details);
        expect(validateSupportReply(published.value, published.retrieved)).toEqual(published.value);

        const other = publishes === ampersandUrl ? encodedAmpersandUrl : ampersandUrl;
        const misgrounded = grounded(other, details);
        expect(() => validateSupportReply(misgrounded.value, misgrounded.retrieved)).toThrow(
            /link|url/i,
        );
    });

    // Decoding widens what matches, so it has to widen it to the evidence and to
    // nothing else. A reference that resolves to a different query, a different
    // host, or a character no evidence URL may contain stays refused.
    it.each([
        'See [docs](https://other.invalid/search?a=1&amp;b=2).',
        'See [docs](https://docs.copilotkit.ai/search?a=1&amp;b=3).',
        'See [docs](https://docs.copilotkit.ai&#46;evil.invalid/search?a=1&amp;b=2).',
        // `&lt;` decodes to a raw '<', which `parseSourceUrl` refuses on both sides
        // of the comparison, so no evidence can ever ground this one.
        'See [docs](https://docs.copilotkit.ai/search?a=1&lt;b=2).',
    ])('still refuses an entity-encoded destination no evidence decodes to %#', (details) => {
        const { value, retrieved } = grounded(ampersandUrl, details);
        expect(() => validateSupportReply(value, retrieved)).toThrow(/link|url/i);
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

    // A run of three or more backticks that opens and closes on one line is a code
    // span, not a fence: the renderer publishes `<p><code>…</code></p>`, with the
    // body inert — the JSX arrives as text, and neither the bare address nor the
    // `www.` host GFM linkifies in prose becomes a link. Three backticks is how an
    // answer quotes something already holding a backtick, so refusing the run
    // discarded correct answers. The published form is pinned against the app's
    // real ReactMarkdown + remark-gfm in apps/web/src/__tests__/qa-components.test.tsx.
    it.each([
        'Use `http://localhost:4000` for local testing.',
        'Render ``<Provider label=`chat` />``.',
        'Render ``<Provider />` literal backtick``.',
        'Render `<Provider />\\`.',
        'A literal backslash \\\\`<Provider />`.',
        '```literal code```',
        'Run ```https://example.invalid/steal``` locally.',
        'Render ```<script>alert(1)</script>``` verbatim.',
        'Mail ```help@example.invalid``` please.',
        'Host ```www.example.invalid/steal``` only.',
        '```a `b` c```',
        '````literal code````',
        // Four backticks is how a fence itself is quoted inline.
        '```` ```tsx ````',
        // Up to three leading spaces is still a paragraph, so still a span.
        '   ```literal code```',
        '```one``` and ```two```',
    ])('preserves valid same-line code spans %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // The refusal the rows above must not take with them. A run of three or more
    // backticks that does not close on its line opens something the renderer will
    // not commit to: a fence whose info string holds a backtick is no fence at all,
    // so the line is published as literal paragraph text and every following line
    // is prose. Refusing rather than guessing which is deliberate and unchanged.
    it.each([
        ['```a`b\n<script>alert(1)</script>\n```', /fence/i],
        ['```tsx`\n<Provider />\n```', /fence/i],
        // Opener of three, closer of four: neither a span nor a fence.
        ['```literal code````', /fence/i],
        // A span does not exempt the rest of its line.
        ['```literal code``` then <script>alert(1)</script>.', /html/i],
        ['```literal code``` then read https://example.invalid/steal.', /link|url/i],
    ] as const)('refuses a backtick run that opens without closing %#', (details, error) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(error);
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
        '[documentation][guide]\n\n[guide]: <//example.invalid/steal>',
        '[documentation][guide]\n\n   [guide]: //example.invalid/steal',
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
        `[documentation][guide]\n\n> [guide]: \`https://example.com/steal\``,
        `[documentation][guide]\n\n- [guide]: \`https://example.com/steal\``,
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

    // A block quote or list item marker only shifts where the line's content starts;
    // the definition behind it still resolves to a clickable link in the renderer.
    it.each([
        '[documentation][ref]\n\n> [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n- [ref]: //example.invalid/steal',
        '> [documentation][ref]\n>\n> [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n>[ref]: //example.invalid/steal',
        '[documentation][ref]\n\n>\t[ref]: //example.invalid/steal',
        '[documentation][ref]\n\n>    [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n   > [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n> > [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n* [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n+ [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n1. [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n1) [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n123456789. [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n-\t[ref]: //example.invalid/steal',
        '[documentation][ref]\n\n-    [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n> - [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n- > [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n> [ref]: <//example.invalid/steal>',
        '[documentation][ref]\n\n> [ref]:\n> //example.invalid/steal',
        '[documentation][ref]\n\n- [ref]:\n  //example.invalid/steal',
        '[documentation][re\nf]\n\n> [re\n> f]: //example.invalid/steal',
        '[documentation][re\nf]\n\n- [re\n  f]: //example.invalid/steal',
        '[documentation][re\\]f]\n\n> [re\\]f]: //example.invalid/steal',
    ])(
        'rejects a non-evidence reference definition behind a block container prefix %#',
        (details) => {
            expect(() => validateSupportReply(reply({ details }), sources)).toThrow(/link|url/i);
        },
    );

    it.each([
        `[documentation][ref]\n\n> [ref]: ${sourceUrl}`,
        `[documentation][ref]\n\n- [ref]: ${sourceUrl}`,
        `[documentation][ref]\n\n> [ref]: <${sourceUrl}>`,
        `[documentation][ref]\n\n1. [ref]: ${sourceUrl}#runtime`,
        `[documentation][re\nf]\n\n> [re\n> f]: ${sourceUrl}`,
        `[documentation][ref]\n\n- [ref]:\n  ${sourceUrl}`,
    ])('allows an evidence destination behind a block container prefix %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // A list item opens a container whose content column its marker width sets, and
    // a later line indented to that column is inside the item — across blank lines,
    // and with no marker of its own to give it away.
    it.each([
        '[documentation][ref]\n\n123. item\n\n     [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n-    item\n\n     [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n10. item\n\n    [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n-   item\n\n    [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n- item\n\n  [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n1. item\n\n   [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n- item\n\n   [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n> 1. item\n>\n>    [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n> 123. item\n>\n>      [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n- item\n\n  - nested\n\n    [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n- item\n\n  > [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n- item\n\n\n  [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n- item\n\n\t[ref]: //example.invalid/steal',
        '[documentation][ref]\n\n- item\n\n[ref]: //example.invalid/steal',
        '[documentation][re\nf]\n\n123. [re\n     f]: //example.invalid/steal',
        '[documentation][re\nf]\n\n> - [re\n> f]: //example.invalid/steal',
    ])('rejects a non-evidence reference definition continuing an open list item %#', (details) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(/link|url/i);
    });

    it.each([
        `[documentation][ref]\n\n123. item\n\n     [ref]: ${sourceUrl}`,
        `[documentation][ref]\n\n-    item\n\n     [ref]: ${sourceUrl}`,
        `[documentation][ref]\n\n> 1. item\n>\n>    [ref]: ${sourceUrl}`,
        `[documentation][ref]\n\n- item\n\n  - nested\n\n    [ref]: ${sourceUrl}`,
        `[documentation][ref]\n\n- item\n\n\t[ref]: ${sourceUrl}`,
        `[documentation][re\nf]\n\n123. [re\n     f]: ${sourceUrl}`,
    ])('allows an evidence destination continuing an open list item %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // Four columns past the item's content column is an indented code block inside
    // the item, so the definition spelled there is a literal example the renderer
    // never resolves. These must stay accepted while the rows above are rejected.
    it.each([
        '[documentation][ref]\n\n123. item\n\n         [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n-    item\n\n         [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n- item\n\n      [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n1. item\n\n       [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n123. item\n\n    [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n- item\n\n  - nested\n\n        [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n    [ref]: //example.invalid/steal',
    ])('keeps an indented literal code example inside a list item %#', (details) => {
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
        // A label may not hold an unescaped bracket, and may not be only whitespace.
        // Both render as literal paragraph text, so neither is a link to ground.
        '[documentation][a[b]\n\n[a[b]: //example.invalid/steal',
        '[documentation][ ]\n\n[ ]: //example.invalid/steal',
        // A code fence carried by a block container is still code. Spelled with a
        // scheme the raw-URL scan recognizes, so the row fails if the fence is
        // read as prose instead of passing for want of anything to match.
        '> ```\n> [ref]: https://example.invalid/steal\n> ```',
    ])('keeps prose that resolves to no reference definition %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // A container marker consumes a bounded prefix, and an already open container is
    // the only one a label may continue through. Past those bounds the renderer sees
    // indented code, a thematic break, or a new block, and resolves no link.
    it.each([
        '[documentation][ref]\n\n>     [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n-     [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n    > [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n    - [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n-[ref]: //example.invalid/steal',
        '[documentation][ref]\n\n1.[ref]: //example.invalid/steal',
        '[documentation][ref]\n\n1234567890. [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n--- [ref]: //example.invalid/steal',
        '[documentation][ref]\n\n[ref]:\n- //example.invalid/steal',
        '[documentation][ref]\n\n[ref]:\n> //example.invalid/steal',
        '[documentation][re\nf]\n\n[re\n- f]: //example.invalid/steal',
        '[documentation][re\nf]\n\n[re\n> f]: //example.invalid/steal',
        '[documentation][re\nf]\n\n> [re\n- f]: //example.invalid/steal',
        '[documentation][re\nf]\n\n- [re\n- f]: //example.invalid/steal',
        '[documentation][re\nf]\n\n- [re\n> f]: //example.invalid/steal',
        '[documentation][re\nf]\n\n> [re\n>\n> f]: //example.invalid/steal',
    ])('keeps prose whose container prefix resolves to no reference definition %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // The fence recognizer and the reference-definition recognizer must agree: a
    // definition spelled inside fenced code is a literal example, not a citation.
    it.each([
        '```md\n[guide]: //example.invalid/steal\n```',
        '```md\n[re\\]f]: //example.invalid/steal\n```',
        '```md\n[re\nf]: //example.invalid/steal\n```',
        '```md\n   [guide]: //example.invalid/steal\n```',
        '```md\n[guide]: <//example.invalid/steal>\n```',
        '```md\n> [guide]: //example.invalid/steal\n```',
        '```md\n- [guide]: //example.invalid/steal\n```',
    ])('does not read a reference definition out of fenced code %#', (details) => {
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

    // A '<' is a tag only where the grammar closes one. Every row below is text the
    // renderer escapes to a literal '<' inside a paragraph — recorded against the
    // app's real ReactMarkdown + remark-gfm in
    // apps/web/src/__tests__/qa-components.test.tsx — so no markup reaches the
    // reader and there is nothing to refuse. `appliesTo` is the field the schema
    // dedicates to version applicability, which makes a '<vN' range that field's
    // own vocabulary; refusing it discarded otherwise valid replies. The numeric
    // spelling was already accepted, so the guard's own boundary sat between two
    // spellings of one sentence.
    it.each([
        { field: 'appliesTo', value: 'Runtimes on <v2 releases' },
        { field: 'appliesTo', value: 'React applications on <v2 patch releases.' },
        { field: 'details', value: 'The option is ignored on <v2 runtimes of the provider.' },
        { field: 'details', value: 'Set a <n threshold before the provider mounts.' },
        { field: 'summary', value: 'Upgrade runtimes on <v2 before mounting the provider.' },
        // Two spellings of the same range, one already accepted before this guard
        // learned the difference. Both must stay accepted together.
        { field: 'appliesTo', value: 'CopilotKit <1.9' },
        { field: 'appliesTo', value: 'CopilotKit <v1.9' },
        // The autolink and the inert '<' in one field: the guard used to strip
        // autolinks before testing for '<', so the autolink survived and the range
        // did not. Both are the renderer's own reading now, and the autolink is
        // still held to the evidence set by the link checks above.
        {
            field: 'appliesTo',
            value: `Runtimes on <v2 releases; see <${sourceUrl}>.`,
        },
    ] as const)('accepts a literal "<" the renderer escapes in $field', ({ field, value }) => {
        expect(validateSupportReply(reply({ [field]: value }), sources)[field]).toBe(value);
    });

    // The contrast that keeps the row above from becoming "anything after '<' is
    // prose": the same '<vN' opening becomes a real tag as soon as the grammar can
    // close one, and an unquoted attribute value is enough to close it. These are
    // refused before and after, for the reason the guard states.
    it.each([
        'Runtimes on <v2 releases> are affected.',
        'Compare <v2 and >v3.',
        'Upgrade <v2 runtimes/> before mounting.',
    ])('rejects a "<vN" opening the grammar closes into a tag %#', (details) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(/html/i);
    });

    // Same assumption, second site: the code-span scanner skipped from '<' to the
    // end of the line whenever no '>' followed, so every code span after an inert
    // '<vN' range went unmasked and its contents were read as prose. An example URL
    // inside a same-line code span is exactly what that scanner exists to exempt.
    it.each([
        'Runtimes on <v2 releases use `https://example.invalid/steal` in examples.',
        'Set a <n threshold, then read `www.example.invalid/steal` from the log.',
    ])('keeps a code span readable after an inert "<" %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // The other half of that assumption: where a '>' did follow, the scanner jumped
    // to it and called everything between the two a tag. Neither row below forms
    // one — the renderer publishes `Compare &lt;b, <code>…</code>, and c&gt; here.`,
    // recorded in apps/web/src/__tests__/qa-components.test.tsx — so the jump ran
    // straight over a code span the renderer does publish, and the example URL
    // inside it was read as a citation the reader could click.
    it.each([
        'Compare <b, `https://example.invalid/steal`, and c> here.',
        'Compare a<b and `https://example.invalid/steal` > c.',
    ])('keeps a code span between an inert "<" and a later ">" %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // The same jump in the other direction: it could land past a backtick, leaving
    // the run after it to pair with a later one, and the span that mispairing
    // invented covered raw HTML the renderer publishes as prose. The renderer
    // escapes that HTML rather than mounting it, so what got through is the policy
    // boundary this guard draws — HTML only inside code — and not markup that runs.
    it.each(['<b`> x `<script>alert(1)</script>` y', '<i`> a `<img src=x onerror=alert(1)>` b'])(
        'refuses raw HTML a mispaired code span covered %#',
        (details) => {
            expect(() => validateSupportReply(reply({ details }), sources)).toThrow(/html/i);
        },
    );

    // Masking replaces what a span encloses, not the span itself. Blanking its
    // delimiters as well would leave `Use <b   > carefully.` where the reader is
    // shown `Use <b x > carefully.`, and the raw-HTML check re-reads the masked
    // view — so the mask would manufacture the tag it exists to see past.
    it.each([
        'Use <b `x` > carefully.',
        'Use <b `x`> carefully.',
        'Mount `<CopilotKit>` above the chat, then read the <v2 note.',
    ])('does not manufacture a tag out of a masked code span %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // What stays refused around the rows above, so "inside a same-line code span"
    // does not widen into "on a line that has one": the same address outside the
    // span is a published link, a '<' the grammar does close is still raw HTML, and
    // a span the grammar closes on a later line is still read as prose — the
    // deliberately conservative multiline policy, unchanged.
    it.each([
        ['Compare <b, https://example.invalid/steal, and c> here.', /link|url/i],
        ['Compare a<b and https://example.invalid/steal > c.', /link|url/i],
        ['Mount <b>the provider</b> in your app.', /html/i],
        ['A line boundary `literal\nhttps://example.invalid/steal\n`.', /link|url/i],
    ] as const)('still refuses what sits outside a same-line code span %#', (details, error) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(error);
    });

    it('preserves literal HTML and example endpoints inside fenced code', () => {
        const details = '```tsx\n<Provider runtimeUrl="http://localhost:4000" />\n```';
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    it('does not treat an inner short fence as the end of a longer code fence', () => {
        const details = '````markdown\n```tsx\n<Provider />\n```\n````';
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // A fence opens where its container's content starts, not at column three, and
    // four columns further in is an indented code block with no fence at all. The
    // renderer publishes every shape below as <pre><code>: inert text that mounts
    // no element and resolves no link, including the bare address and `www.` host
    // GFM would otherwise linkify. A step or a quoted example is where a support
    // answer puts its code, so reading these as prose discards correct answers.
    // The published form is pinned against the app's real ReactMarkdown +
    // remark-gfm in apps/web/src/__tests__/qa-components.test.tsx.
    it.each([
        '- Example:\n\n    ```tsx\n    <CopilotKit runtimeUrl="/api/copilotkit" />\n    ```',
        '> ```tsx\n> <CopilotKit runtimeUrl="/api/copilotkit" />\n> ```',
        '10. Example:\n\n    ```text\n    https://example.invalid/documented-example\n    ```',
        '> ```tsx\n> <Provider runtimeUrl="http://localhost:4000" />\n> ```',
        '- Example:\n\n    ~~~tsx\n    <Provider />\n    ~~~',
        '> > ```tsx\n> > <Provider />\n> > ```',
        '> - Example:\n>\n>   ```tsx\n>   <Provider />\n>   ```',
        '- outer\n\n  - inner\n\n    ```tsx\n    <Provider />\n    ```',
        'Example:\n\n    <Provider runtimeUrl="http://localhost:4000" />',
        'Example:\n\n    https://example.invalid/documented-example',
        '- Example:\n\n      <Provider />',
        '- Example:\n\n      https://example.invalid/documented-example',
        '- Example:\n\n    ```text\n    help@example.invalid\n    ```',
        '> ```text\n> www.example.invalid/steal\n> ```',
    ])('keeps code a block container carries out of prose validation %#', (details) => {
        expect(validateSupportReply(reply({ details }), sources).details).toBe(details);
    });

    // The container is not what exempts the text; the code is. The same containers
    // carrying a paragraph stay validated, and so does anything following the fence
    // they carry once it closes — including a line that continues the list item.
    it.each([
        ['> <script>alert(1)</script>', /html/i],
        ['- <script>alert(1)</script>', /html/i],
        ['> > <script>alert(1)</script>', /html/i],
        ['> Read https://example.invalid/steal.', /link|url/i],
        ['- Read https://example.invalid/steal.', /link|url/i],
        ['- Example:\n\n    Read https://example.invalid/steal.', /link|url/i],
        ['> ```tsx\n> <Provider />\n> ```\n\n<script>alert(1)</script>', /html/i],
        [
            '- Example:\n\n    ```text\n    example\n    ```\n\n  Read https://example.invalid/steal.',
            /link|url/i,
        ],
    ] as const)('still validates prose a block container carries %#', (details, error) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(error);
    });

    // An open fence is refused for one reason: supportReplyDetails appends the
    // applicability, version and sources footer to `details`, and the code block
    // would swallow all of it. Only a top-level fence can. A blank line closes a
    // block container before anything inside it, so the renderer ends a container's
    // fence with the container and publishes the footer after it — which is why the
    // second group must not inherit the refusal along with the fix above.
    it.each([
        '```tsx\n<Provider />',
        '~~~tsx\n<Provider />',
        '```tsx\n<Provider />\n~~~',
        '````markdown\n<Provider />\n```',
    ])('refuses an open fence that would swallow the appended footer %#', (details) => {
        expect(() => validateSupportReply(reply({ details }), sources)).toThrow(/fence/i);
    });

    it.each([
        '> ```tsx\n> <Provider />',
        '- Example:\n\n    ```tsx\n    <Provider />',
        '> - Example:\n>\n>   ```tsx\n>   <Provider />',
    ])('keeps a fence its block container closes for it %#', (details) => {
        const value = reply({ details });
        expect(validateSupportReply(value, sources).details).toBe(details);
        // The footer the refusal exists to protect is present and outside the fence.
        expect(supportReplyDetails(value)).toContain('\n\n**API version:** v2');
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
            // The one spelling that is not equivalent: a GFM autolink literal drops
            // an unmatched trailing ')', so this publishes .../setup, not the
            // retrieved .../setup) — a destination no evidence backs.
            'Read https://docs.copilotkit.ai/reference/setup).',
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
        // Every field reaches the same prose scan, and the applicability line is
        // escaped for Markdown structure only — never for the `@` and `.` a GFM
        // autolink literal is built from — so the scan is its only defense.
        {
            field: 'summary',
            value: 'Contact help@example.invalid for instructions.',
            error: /link|url/i,
        },
        {
            field: 'details',
            value: 'Contact help@example.invalid for instructions.',
            error: /link|url/i,
        },
        {
            field: 'appliesTo',
            value: 'Contact help@example.invalid for instructions.',
            error: /link|url/i,
        },
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

// The reader receives the composed reply, not the fields it was assembled from,
// and publication moves both of the fields it composes: `details` is trimmed and
// `appliesTo` is normalized onto one line and escaped. Validating the field as
// written therefore answers a question about a string nobody publishes. Every row
// below asserts the string `supportReplyDetails` actually emits, so a transform
// applied after the evidence check can neither reactivate a link that check never
// saw nor rewrite one it approved.
//
// The published strings are pinned against the app's real ReactMarkdown +
// remark-gfm in apps/web/src/__tests__/qa-components.test.tsx, which is what makes
// "publishes no link" and "publishes this href" claims here mean what they say.
// An ordinary applicability sentence publishing unchanged is already pinned by
// 'renders applicability, API version, and unique evidence links without repeating
// the summary' above.
describe('published form of a validated reply', () => {
    const guideUrl = 'https://docs.copilotkit.ai/reference/my-guide';
    const guideSources = sources.map((source) => ({ ...source, sourceUrl: guideUrl }));
    const footer = '\n\n**Applies to:** React applications using the provider.';

    // Four leading spaces are an indented code block, which is why the evidence
    // check credits the address inside one as inert. Trimming the field removed
    // exactly those spaces, and the reader received a paragraph with a live link to
    // a host no evidence mentions. Blank edges carry no structure and still go.
    it.each([
        '    Read https://example.invalid/steal now.',
        '    Read https://example.invalid/steal now.\n',
        '\n    Read https://example.invalid/steal now.',
        '\n    Read https://example.invalid/steal now.  \n\n',
    ])('publishes an indented example block as the code it validated %#', (details) => {
        const value = reply({ details });

        expect(validateSupportReply(value, sources)).toEqual(value);
        expect(
            supportReplyDetails(value).startsWith(
                `    Read https://example.invalid/steal now.${footer}`,
            ),
        ).toBe(true);
    });

    it('publishes a fenced example block still fenced', () => {
        const details = '```text\nhttps://example.invalid/documented-example\n```';
        const value = reply({ details });

        expect(validateSupportReply(value, sources)).toEqual(value);
        expect(supportReplyDetails(value).startsWith(`${details}${footer}`)).toBe(true);
    });

    it('publishes a grounded link in details with the href it validated', () => {
        const value = reply({
            details: `See [the guide](${guideUrl}).`,
            evidence: [{ sourceUrl: guideUrl, quote }],
        });

        expect(validateSupportReply(value, guideSources)).toEqual(value);
        expect(supportReplyDetails(value).startsWith(`See [the guide](${guideUrl}).`)).toBe(true);
    });

    // Normalizing the applicability onto one line removes the same indentation, and
    // the escape it is then put through covers Markdown structure only — never the
    // '@', '.' and '/' a GFM autolink literal is built from. Both rows published a
    // live link to a host outside the evidence set.
    it.each(['    Read www.example.invalid/steal now.', '    help@example.invalid users'])(
        'refuses applicability whose published form links off the evidence %#',
        (appliesTo) => {
            expect(() => validateSupportReply(reply({ appliesTo }), sources)).toThrow(/link|url/i);
        },
    );

    // The corruption in the other direction: the escape rewrote the cited URL's own
    // characters, and the reader clicked an address the evidence check never saw.
    it('publishes a cited applicability URL with the href it validated', () => {
        const value = reply({
            appliesTo: guideUrl,
            evidence: [{ sourceUrl: guideUrl, quote }],
        });

        expect(validateSupportReply(value, guideSources)).toEqual(value);
        expect(supportReplyDetails(value)).toContain(`**Applies to:** ${guideUrl}\n`);
    });

    // The source list is the one part of the composed details this module writes
    // rather than the model, and it is subject to the same contract. An inline
    // destination is decoded, so a cited URL spelled with a character reference
    // published as the address that reference decodes to — a different page, and
    // one no evidence names. The href the literal below publishes is pinned in
    // apps/web/src/__tests__/qa-components.test.tsx.
    it('publishes a source link whose destination decodes to the cited URL', () => {
        const value = reply({
            appliesTo: '',
            evidence: [{ sourceUrl: encodedAmpersandUrl, quote }],
        });
        const retrieved = sources.map((source) => ({
            ...source,
            sourceUrl: encodedAmpersandUrl,
        }));

        expect(validateSupportReply(value, retrieved)).toEqual(value);
        expect(supportReplyDetails(value)).toContain(
            '- [Source 1](<https://docs.copilotkit.ai/search?a=1&amp;amp;b=2>)',
        );
    });

    // A citation written as a link is the same contract: the destination the reader
    // clicks stays the destination the evidence check approved.
    it('publishes a cited applicability link with the href it validated', () => {
        const value = reply({
            appliesTo: `See [the guide](${guideUrl}).`,
            evidence: [{ sourceUrl: guideUrl, quote }],
        });

        expect(validateSupportReply(value, guideSources)).toEqual(value);
        expect(supportReplyDetails(value)).toContain(
            `**Applies to:** See [the guide](${guideUrl}).\n`,
        );
    });
});

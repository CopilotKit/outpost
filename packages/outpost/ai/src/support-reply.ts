import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Definition, Image, Link, Nodes } from 'mdast';
import { z } from 'zod';
import type { SearchResult } from './types.js';

/** Keep provider output shape constraints separate from deterministic validation. */
export const supportReplySchema = z.strictObject({
    decision: z.enum(['answer', 'partial', 'route']),
    summary: z.string(),
    details: z.string(),
    apiVersion: z.enum(['v1', 'v2', 'unknown']),
    appliesTo: z.string(),
    evidence: z.array(
        z.strictObject({
            sourceUrl: z.string(),
            quote: z.string(),
        }),
    ),
    handoffReason: z.string(),
});

export type SupportReply = z.infer<typeof supportReplySchema>;

const SUMMARY_WORD_LIMIT = 80;
const ROUTE_WORD_LIMIT = 60;
const DETAILS_WORD_LIMIT = 1200;

function wordCount(text: string): number {
    return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeQuote(text: string): string {
    return text
        .replace(/^\s*(?:L\d+[:|]?\s+|\d+\s*[:|]\s?)/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * @internal Shared citation contract for strict retrieval and reply validation;
 * intentionally omitted from the public AI barrel. Citations must be absolute
 * HTTP(S) URLs without embedded credentials or invalid raw whitespace.
 */
export function parseSourceUrl(value: string): URL | undefined {
    try {
        if (!/^https?:\/\//i.test(value) || /[\s<>"\\]/.test(value)) return undefined;
        const url = new URL(value);
        if (url.username || url.password) return undefined;
        return url;
    } catch {
        return undefined;
    }
}

function canonicalSourceUrl(value: string): string | undefined {
    const url = parseSourceUrl(value);
    if (!url) return undefined;
    url.hash = '';
    return url.href;
}

function unescapeMarkdownDestination(value: string): string {
    return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

function inlineDestinationEnd(destination: string): number {
    if (destination.startsWith('<')) {
        for (let index = 1; index < destination.length; index++) {
            if (destination[index] === '\\') {
                index++;
                continue;
            }
            if (destination[index] === '>') return index + 1;
            if (destination[index] === '\n') break;
        }
        return destination.length;
    }

    let depth = 0;
    for (let index = 0; index < destination.length; index++) {
        const character = destination[index];
        if (character === '\\') {
            index++;
            continue;
        }
        if (/\s/.test(character) || (character === ')' && depth === 0)) return index;
        if (character === '(') depth++;
        if (character === ')') depth--;
    }
    return destination.length;
}

/** The grammar the chat renderer runs: remark-parse plus the GFM extension. */
function parseMarkdown(text: string): Nodes {
    return fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

interface CodeNodes {
    /** Line ranges of every code block, one-based and inclusive, at any depth. */
    blocks: Array<[number, number]>;
    /** `line:column` of each code span's opening run, one-based, at any depth. */
    spanStarts: Set<string>;
}

function collectCodeNodes(node: Nodes, into: CodeNodes): void {
    if (node.type === 'code' && node.position) {
        into.blocks.push([node.position.start.line, node.position.end.line]);
    }
    if (node.type === 'inlineCode' && node.position) {
        into.spanStarts.add(`${node.position.start.line}:${node.position.start.column}`);
    }
    if ('children' in node) for (const child of node.children) collectCodeNodes(child, into);
}

/**
 * A paragraph appended after a blank line, to ask the parser whether anything
 * appended to the field would survive. `supportReplyDetails` appends the
 * applicability, version and sources footer to `details`, and a fence still open
 * at the end of the field absorbs all of it into the code block instead. Only a
 * top-level fence can: a blank line closes every block container first, so a
 * fence carried by a list item or a block quote ends with its container and the
 * footer survives. Asking the parser settles that for every nesting at once,
 * which tracking fence state by hand did not.
 */
const APPENDED_FOOTER_PROBE = 'outpost-appended-footer-probe';

/**
 * Preserve code verbatim for rendering, but do not interpret example URLs as
 * citations.
 *
 * Which lines are code is block structure, not a line pattern: a fence opens
 * wherever its container's content starts, so a fence inside a list item or a
 * block quote begins past column three and four columns further in is indented
 * code with no fence at all. Recognizing fences by their column answered a
 * different question than the renderer's, and discarded correct answers whose
 * examples were written inside a step or a quote. Asking the parser which nodes
 * are code removes the column from the question.
 *
 * Nor is a run of backticks at the start of a line a fence marker by itself. The
 * same run closed later on the same line is a code span — how an answer quotes a
 * literal already holding a backtick, up to and including a fence — and the
 * renderer publishes it inline, with its body inert. Only a run left open is the
 * ambiguity the refusal below exists for.
 */
function proseOutsideFences(text: string): string {
    const normalized = text.replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    const code: CodeNodes = { blocks: [], spanStarts: new Set() };
    collectCodeNodes(parseMarkdown(normalized), code);
    const codeLines = new Set<number>();
    for (const [start, end] of code.blocks) {
        for (let line = start; line <= end; line++) codeLines.add(line);
    }

    for (const [index, line] of lines.entries()) {
        if (codeLines.has(index + 1)) continue;
        // A backtick fence's info string may hold no backtick, so a line that looks
        // like one and is not a code span opens something else. Refusing rather than
        // guessing is deliberate and unchanged; it now applies only where the parser
        // agrees the line is neither already inside code nor opening a span here.
        const marker = /^ {0,3}(`{3,})(.*)$/.exec(line);
        if (!marker || !marker[2].includes('`')) continue;
        const column = line.length - marker[1].length - marker[2].length + 1;
        if (!code.spanStarts.has(`${index + 1}:${column}`)) {
            throw new Error('Invalid code fence in support reply');
        }
    }
    // Only a code block reaching the last line can still be open, so nothing else
    // needs the probe parse.
    if (codeLines.has(lines.length)) {
        const probed = parseMarkdown(`${normalized}\n\n${APPENDED_FOOTER_PROBE}`);
        if ('children' in probed && probed.children.at(-1)?.type === 'code') {
            throw new Error('Unclosed code fence in support reply');
        }
    }

    return lines.map((line, index) => (codeLines.has(index + 1) ? '' : line)).join('\n');
}

interface ReferenceDefinition {
    /** Inclusive, zero-based line range the whole definition occupies. */
    firstLine: number;
    lastLine: number;
    /** Destination as the parser decodes it: escapes and references resolved. */
    destination: string;
    /** Offsets of the destination alone in the text the definition was found in. */
    destinationStart: number;
    destinationEnd: number;
}

/**
 * Offsets of the destination inside a definition the parser has already
 * delimited. The parser reports the node's range and the decoded URL but not the
 * destination's own span, and the raw-URL scans below must skip exactly the text
 * the destination check already covered — no more, so that a URL written inside
 * a label stays subject to them. Returning nothing masks nothing, which leaves
 * those scans stricter rather than looser.
 */
function destinationSpan(
    text: string,
    start: number,
    end: number,
): { from: number; to: number } | undefined {
    let cursor = start + 1;
    while (cursor < end && text[cursor] !== ']') cursor += text[cursor] === '\\' ? 2 : 1;
    if (text[cursor] !== ']' || text[cursor + 1] !== ':') return undefined;
    cursor += 2;
    while (cursor < end && /\s/.test(text[cursor])) cursor++;
    if (text[cursor] === '<') {
        for (let scan = cursor + 1; scan < end; scan++) {
            if (text[scan] === '\\') {
                scan++;
                continue;
            }
            if (text[scan] === '>') return { from: cursor, to: scan + 1 };
        }
    }
    let scan = cursor;
    while (scan < end && !/\s/.test(text[scan])) scan++;
    return scan > cursor ? { from: cursor, to: scan } : undefined;
}

/** Definitions can sit at any depth, inside block quotes and list items. */
function collectDefinitions(node: Nodes, into: Definition[]): void {
    if (node.type === 'definition') into.push(node);
    if ('children' in node) for (const child of node.children) collectDefinitions(child, into);
}

/** Raw HTML the grammar resolves, at any depth — block level and inline alike. */
function collectHtml(node: Nodes, into: string[]): void {
    if (node.type === 'html') into.push(node.value);
    if ('children' in node) for (const child of node.children) collectHtml(child, into);
}

/**
 * Whether the renderer resolves any raw HTML out of `text`.
 *
 * A '<' is the start of a tag only where the grammar can close one: a tag name,
 * well-formed attributes and a '>', or a comment, processing instruction,
 * declaration or CDATA section with its own terminator. Everything else is text
 * the renderer escapes to a literal '<' — `appliesTo: 'Runtimes on <v2 releases'`
 * publishes `<p>Runtimes on &lt;v2 releases</p>`, markup-free.
 *
 * Treating every '<' before a letter as a tag drew the line in the wrong place.
 * It put the two spellings of one version range on opposite sides — `<1.9` was
 * prose because a digit is not a tag name, `<v1.9` was refused — and `appliesTo`
 * is the field the schema dedicates to version applicability, so a range is that
 * field's own vocabulary rather than an injection attempt. Asking the grammar
 * moves the line to where the reader's renderer actually puts it, and keeps the
 * comment, processing-instruction and closing-tag forms the pattern covered: it
 * reports those as HTML too.
 */
function publishesRawHtml(text: string): boolean {
    const html: string[] = [];
    collectHtml(parseMarkdown(text), html);
    return html.length > 0;
}

interface InlineDestination {
    /** Offset of the `]` whose `](` opened the destination. */
    openerStart: number;
    /** Offset the destination itself begins at, any padding whitespace skipped. */
    start: number;
}

/**
 * Where an inline link's or image's destination sits in `text`, given the node
 * range the parser reported. The node carries its decoded URL but not the
 * destination's own span, and the raw-URL scans below must skip exactly the text
 * the destination check already covered. The label ends at its own matching right
 * bracket — labels nest and escape, which is why the bracket is counted rather
 * than searched for — and `(` must follow it, which a reference or collapsed link
 * has instead of a destination. Returning nothing checks and masks nothing for
 * that node, which leaves the scans below stricter rather than looser.
 */
function inlineDestination(
    text: string,
    start: number,
    end: number,
): InlineDestination | undefined {
    let cursor = text[start] === '!' ? start + 1 : start;
    if (text[cursor] !== '[') return undefined;
    let depth = 0;
    for (; cursor < end; cursor++) {
        if (text[cursor] === '\\') {
            cursor++;
            continue;
        }
        if (text[cursor] === '[') depth++;
        else if (text[cursor] === ']' && --depth === 0) break;
    }
    if (text[cursor] !== ']' || text[cursor + 1] !== '(') return undefined;
    const openerStart = cursor;
    cursor += 2;
    while (cursor < end && /\s/.test(text[cursor])) cursor++;
    return { openerStart, start: cursor };
}

/** Inline links and images can sit at any depth, including inside a link label. */
function collectInlineLinks(node: Nodes, into: (Link | Image)[]): void {
    if (node.type === 'link' || node.type === 'image') into.push(node);
    if ('children' in node) for (const child of node.children) collectInlineLinks(child, into);
}

/**
 * Offsets in `text` of the destination of every link or image written in the
 * `[label](destination)` form, found with the parser the renderer runs rather
 * than by looking for `](`.
 *
 * Those two questions have different answers. `](` is a destination opener only
 * where a link label closed on it; everywhere else the renderer prints it as
 * punctuation and publishes nothing a reader can click. Scanning for the literal
 * pair reads `The literal punctuation ](not a link) …` as a citation of `not` and
 * discards the reply, while a real subscript such as `arr[i](x)` — which this
 * renderer does publish as a link — looks like the same punctuation. Asking the
 * grammar separates them the way the reader's browser will.
 */
function inlineDestinations(text: string): InlineDestination[] {
    const nodes: (Link | Image)[] = [];
    collectInlineLinks(
        fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }),
        nodes,
    );
    return nodes.flatMap(({ position }) => {
        const start = position?.start.offset;
        const end = position?.end.offset;
        if (start === undefined || end === undefined) return [];
        const destination = inlineDestination(text, start, end);
        return destination === undefined ? [] : [destination];
    });
}

/**
 * The same answer per line and relative to the line's own start: the columns a
 * `](` really opens a destination at. The inline-code scan below runs a line at a
 * time, and a destination is not code — a backtick inside one is a literal the
 * renderer prints — so that scan has to skip destinations, and it had been finding
 * them by the same literal `](` this file no longer trusts anywhere else.
 */
function inlineDestinationColumns(text: string): ReadonlySet<number>[] {
    const lineStarts: number[] = [];
    let offset = 0;
    for (const line of text.split('\n')) {
        lineStarts.push(offset);
        offset += line.length + 1;
    }
    const columns = lineStarts.map(() => new Set<number>());
    for (const { openerStart } of inlineDestinations(text)) {
        let line = lineStarts.length - 1;
        while (line > 0 && lineStarts[line] > openerStart) line--;
        columns[line].add(openerStart - lineStarts[line]);
    }
    return columns;
}

function collectDestinations(node: Nodes, into: string[]): void {
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
        into.push(node.url);
    }
    if ('children' in node) for (const child of node.children) collectDestinations(child, into);
}

/**
 * Every destination `text` resolves to under the renderer the chat surface runs:
 * `react-markdown` with `remark-gfm`, whose parser and GFM extension are the ones
 * imported here at the versions the app resolves.
 *
 * The scans below find URLs by pattern, which answers a different question than
 * the renderer's. GFM linkifies a bare address, a `www.` host and a `mailto:` or
 * `xmpp:` prefix that no raw-URL pattern here matches, and it publishes a `www.`
 * host over http:// rather than the https:// a pattern match would have to guess.
 * Asking the grammar for the destinations instead removes the guesswork: what is
 * checked is exactly what the reader can click, in the form they will click it.
 */
function publishedDestinations(text: string): string[] {
    const destinations: string[] = [];
    collectDestinations(parseMarkdown(text), destinations);
    return destinations;
}

/**
 * Every link reference definition in `text`, located with the parser the chat
 * renderer itself runs on — `mdast-util-from-markdown`, which is what
 * react-markdown's remark-parse uses, at the one version installed here.
 *
 * Recognizing definitions by hand drifted from that renderer once per review
 * round: escaped closing brackets, then labels spanning lines, then block quote
 * and list markers, then the content column an open list item keeps across blank
 * lines. Each of those is block structure rather than a line pattern, so each
 * hand-written bound fixed an instance and left the class. Asking the renderer's
 * own parser which definitions exist removes the class.
 */
function referenceDefinitions(text: string): ReferenceDefinition[] {
    const nodes: Definition[] = [];
    collectDefinitions(fromMarkdown(text), nodes);
    return nodes.flatMap(({ position, url }) => {
        const start = position?.start.offset;
        const end = position?.end.offset;
        if (!position || start === undefined || end === undefined) return [];
        const span = destinationSpan(text, start, end);
        return [
            {
                firstLine: position.start.line - 1,
                lastLine: position.end.line - 1,
                destination: url,
                destinationStart: span?.from ?? start,
                destinationEnd: span?.to ?? start,
            },
        ];
    });
}

/**
 * Exclude same-line code spans only. Crossing a line can cross a Markdown block
 * boundary, so multiline spans remain conservatively subject to prose checks.
 * Closing runs must match the opening length; backslashes are literal in code.
 *
 * `destinationColumns` holds the columns a link or image destination is written
 * at, which are skipped because a backtick inside a destination opens nothing.
 * Everywhere else `](` is punctuation the reader sees as text, and skipping it
 * would step over a code span the renderer does form.
 */
function proseOutsideInlineCode(line: string, destinationColumns: ReadonlySet<number>): string {
    let cursor = 0;
    let preserved = 0;
    let prose = '';
    while (cursor < line.length) {
        if (line[cursor] === '\\') {
            cursor += 2;
            continue;
        }
        // A backtick inside a tag is an attribute character, not a code delimiter,
        // so skip the tag. A '<' with no '>' after it on the line closes no tag, so
        // there is nothing to skip: abandoning the rest of the line there left every
        // code span after an inert '<vN' range unmasked, and read its contents —
        // example URLs included — as prose.
        if (/^<(?:!|\?|\/?[a-z])/i.test(line.slice(cursor))) {
            const end = line.indexOf('>', cursor);
            if (end < 0) {
                cursor++;
                continue;
            }
            cursor = end + 1;
            continue;
        }
        if (line.startsWith('](', cursor) && destinationColumns.has(cursor)) {
            cursor += 2;
            const destination = line.slice(cursor);
            const end = inlineDestinationEnd(destination);
            cursor += end + (destination[end] === ')' ? 1 : 0);
            continue;
        }
        if (line[cursor] !== '`') {
            cursor++;
            continue;
        }
        let openingEnd = cursor + 1;
        while (line[openingEnd] === '`') openingEnd++;
        const length = openingEnd - cursor;
        let closing = line.indexOf('`', openingEnd);
        let closingEnd = -1;
        while (closing >= 0) {
            let end = closing + 1;
            while (line[end] === '`') end++;
            if (end - closing === length) {
                closingEnd = end;
                break;
            }
            closing = line.indexOf('`', end);
        }
        if (closingEnd >= 0) {
            prose += line.slice(preserved, cursor) + ' ';
            preserved = closingEnd;
            cursor = closingEnd;
        } else {
            cursor = openingEnd;
        }
    }
    return prose + line.slice(preserved);
}

function validateProse(text: string, knownUrls: ReadonlySet<string>): void {
    const fenced = proseOutsideFences(text);
    // Backticks anywhere in a reference definition are label or URL characters,
    // not code, and a label can span lines, so exempt whole definitions found by
    // the multiline scan rather than testing each line on its own.
    const definitionLines = new Set<number>();
    for (const definition of referenceDefinitions(fenced)) {
        for (let line = definition.firstLine; line <= definition.lastLine; line++) {
            definitionLines.add(line);
        }
    }
    const destinationColumns = inlineDestinationColumns(fenced);
    const prose = fenced
        .split('\n')
        .map((line, index) =>
            definitionLines.has(index)
                ? line
                : proseOutsideInlineCode(line, destinationColumns[index]),
        )
        .join('\n');
    const proseWithoutMarkdownDestinations = prose.split('');
    const maskMarkdownDestination = (start: number, end: number): void => {
        for (let index = start; index < end; index++) proseWithoutMarkdownDestinations[index] = ' ';
    };
    const checkUrl = (
        raw: string,
        allowProsePunctuation = false,
        markdownDestination = false,
    ): void => {
        let candidate = markdownDestination ? unescapeMarkdownDestination(raw) : raw;
        // Prose punctuation and Markdown closing delimiters are not URL content.
        // Try the full URL first, so a retrieved URL ending in ')' still works.
        while (candidate) {
            const canonical = canonicalSourceUrl(
                // GFM publishes a scheme-less `www.` host over http://, so that is
                // the destination to compare against; https:// would be invented.
                candidate.startsWith('www.') ? `http://${candidate}` : candidate,
            );
            if (canonical && knownUrls.has(canonical)) return;
            if (!allowProsePunctuation || !/[.,;:!?)\]}]$/.test(candidate)) break;
            candidate = candidate.slice(0, -1);
        }
        throw new Error('Support reply link URL must belong to validated source evidence');
    };

    // Validate destinations separately so relative, protocol-relative, and
    // non-HTTP links cannot bypass the checks for raw URLs below. Each is read
    // as the reply spells it, not as the parser decodes it, so a destination the
    // renderer resolves through a character reference stays subject to them too.
    for (const { start: destinationStart } of inlineDestinations(prose)) {
        const destination = prose.slice(destinationStart);
        if (destination.startsWith('<')) {
            const end = inlineDestinationEnd(destination);
            checkUrl(destination.slice(1, end > 0 ? end - 1 : end), false, true);
            maskMarkdownDestination(destinationStart, destinationStart + end);
            continue;
        }
        const end = inlineDestinationEnd(destination);
        checkUrl(destination.slice(0, end), false, true);
        maskMarkdownDestination(destinationStart, destinationStart + end);
    }
    // Mask the destination alone: a label is not rendered, and leaving it visible
    // keeps a raw URL inside a multiline label subject to the checks below.
    for (const definition of referenceDefinitions(prose)) {
        checkUrl(definition.destination);
        maskMarkdownDestination(definition.destinationStart, definition.destinationEnd);
    }
    const proseRawUrlView = proseWithoutMarkdownDestinations.join('');
    for (const match of proseRawUrlView.matchAll(/<(https?:\/\/[^\s<>]+)>/gi)) {
        checkUrl(match[1]);
    }
    for (const match of proseRawUrlView.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi)) {
        checkUrl(match[0], true);
    }
    // The scans above look for URLs the model wrote; this one asks the renderer's
    // own grammar which destinations the published Markdown resolves to, and holds
    // every one of them to the same evidence. It runs over the original text, not
    // the masked view, because the grammar decides on its own what is code, what
    // is a link and what is inert prose the reader can never click.
    for (const destination of publishedDestinations(text)) checkUrl(destination);

    // Run over the masked prose, not the original text: the masking above is what
    // implements "only inside code", and it is deliberately stricter than the
    // grammar for a span that crosses a line. The grammar decides the one question
    // left — tag or literal '<'. An autolink is a link to it, not HTML, so the
    // pre-strip that used to exempt `<https://…>` from the pattern is gone with the
    // pattern; the destination checks above still hold that autolink to evidence.
    if (publishesRawHtml(prose)) {
        throw new Error('Raw HTML is only allowed inside code in a support reply');
    }
}

/** Validate model output against the exact retrieved material before publishing. */
export function validateSupportReply(reply: unknown, sources: SearchResult[]): SupportReply {
    const parsed = supportReplySchema.parse(reply);
    const summaryLimit = parsed.decision === 'route' ? ROUTE_WORD_LIMIT : SUMMARY_WORD_LIMIT;
    if (
        !parsed.summary.trim() ||
        wordCount(parsed.summary) > summaryLimit ||
        /\n\s*\n/.test(parsed.summary.replace(/\r\n?/g, '\n')) ||
        /`{3,}|~{3,}/.test(parsed.summary) ||
        /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\||[=-]{2,}\s*$)/m.test(parsed.summary)
    ) {
        throw new Error(
            `Support reply summary must be one paragraph of at most ${summaryLimit} words`,
        );
    }
    if (wordCount(parsed.details) > DETAILS_WORD_LIMIT) {
        throw new Error(`Support reply details must be at most ${DETAILS_WORD_LIMIT} words`);
    }
    if (parsed.decision === 'route' && !parsed.handoffReason.trim()) {
        throw new Error('A routed support reply requires a handoff reason');
    }
    if (parsed.decision !== 'route' && !parsed.evidence.length) {
        throw new Error('An answer or partial answer requires source evidence');
    }

    for (const evidence of parsed.evidence) {
        const quote = normalizeQuote(evidence.quote);
        if (
            !parseSourceUrl(evidence.sourceUrl) ||
            quote.length < 12 ||
            !sources.some(
                (source) =>
                    source.sourceUrl === evidence.sourceUrl &&
                    normalizeQuote(source.content).includes(quote),
            )
        ) {
            throw new Error('Support reply evidence must quote a matching retrieved source');
        }
        // Final output can choose v2 after an unfiltered search or read_source.
        // Validate the cited material here as well as at the retrieval boundary.
        if (
            parsed.decision !== 'route' &&
            parsed.apiVersion === 'v2' &&
            sources.some(
                (source) =>
                    source.sourceUrl === evidence.sourceUrl &&
                    /v1-deprecated/i.test(`${source.sourceUrl} ${source.title}`),
            )
        ) {
            throw new Error('A v2 support reply cannot cite v1-deprecated source evidence');
        }
    }
    const knownUrls = new Set(
        parsed.evidence.flatMap((evidence) => {
            const canonical = canonicalSourceUrl(evidence.sourceUrl);
            return canonical ? [canonical] : [];
        }),
    );
    for (const text of [parsed.summary, parsed.details, parsed.appliesTo]) {
        validateProse(text, knownUrls);
    }
    return parsed;
}

function escapeMarkdown(text: string): string {
    return text.replace(/\s+/g, ' ').replace(/[\\`*_[\]{}()#+!|<>~-]/g, '\\$&');
}

/** Evidence quotes establish grounding internally; public replies link the sources once. */
export function supportReplyDetails(reply: SupportReply): string {
    if (reply.decision === 'route') return '';
    const parts = [reply.details.trim()];
    if (reply.appliesTo.trim())
        parts.push(`**Applies to:** ${escapeMarkdown(reply.appliesTo.trim())}`);
    parts.push(`**API version:** ${reply.apiVersion}`);
    const urls = [...new Set(reply.evidence.map((evidence) => evidence.sourceUrl))];
    if (urls.length) {
        parts.push(
            '**Sources**\n\n' +
                urls.map((url, index) => `- [Source ${index + 1}](<${url}>)`).join('\n'),
        );
    }
    return parts.filter(Boolean).join('\n\n');
}

/** Text for grounding and linting includes the citations the user will see. */
export function supportReplyText(reply: SupportReply): string {
    return [reply.summary, supportReplyDetails(reply)].filter(Boolean).join('\n\n');
}

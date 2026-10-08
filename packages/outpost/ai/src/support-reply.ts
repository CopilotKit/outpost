import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Definition, Image, InlineCode, Link, Nodes } from 'mdast';
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
    /**
     * Lines a code span already covers where they begin, one-based: every line of a
     * span after the one that opened it, through the line its closing run is on.
     */
    spanContinuations: Set<number>;
}

function collectCodeNodes(node: Nodes, into: CodeNodes): void {
    if (node.type === 'code' && node.position) {
        into.blocks.push([node.position.start.line, node.position.end.line]);
    }
    if (node.type === 'inlineCode' && node.position) {
        into.spanStarts.add(`${node.position.start.line}:${node.position.start.column}`);
        for (let line = node.position.start.line + 1; line <= node.position.end.line; line++) {
            into.spanContinuations.add(line);
        }
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
 * same run closed later — on that line or a later one — is a code span, how an
 * answer quotes a literal already holding a backtick, up to and including a
 * fence, and the renderer publishes it inline with its body inert. Only a run
 * left open is the ambiguity the refusal below exists for.
 *
 * Which lines a span covers is the whole answer to that, not where each one
 * opens. A span closing on a later line leaves every line between inside code,
 * and a line beginning inside one opens nothing: its backtick run is the span's
 * content or its own closing run. Recording openings alone refused the
 * continuation lines of spans the renderer had already closed.
 */
function proseOutsideFences(text: string): string {
    const normalized = text.replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    const code: CodeNodes = { blocks: [], spanStarts: new Set(), spanContinuations: new Set() };
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
        // agrees the line is neither already inside code, nor continuing a span
        // opened above it, nor opening one here.
        if (code.spanContinuations.has(index + 1)) continue;
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
 * Past the padding between a definition's `]:` and its destination, container
 * markers included.
 *
 * The parser reports a definition's range in the text it was found in, and a
 * block container's markers are not part of the node it carries — so the raw
 * text inside that range still holds them, and a destination written on a
 * continuation line sits after one. Skipping whitespace alone stopped on the
 * '>', reported the marker itself as the destination, and so masked the marker
 * while leaving the destination — already checked once, in the one spelling the
 * raw scans below cannot accept — exposed to them. A reply whose only citation
 * was its own evidence was discarded for it, at every spelling the parser
 * decodes: `…?a=1&amp;b=2` and a destination ending in an escaped ')'.
 *
 * What a continuation prefix may hold is bounded by the grammar rather than
 * guessed: indentation, then one '>' per open block quote, each with its own
 * optional space. A list item contributes indentation only, so the nesting is
 * covered by the same two rules. Exactly one line ending is stepped over,
 * because a blank line ends the definition and the parser would not have
 * reported one spanning it; and a '>' is skipped only at the start of a line,
 * where the grammar has no other reading for it. Line endings are matched in
 * both spellings even though every caller normalizes CRLF first, so the bound
 * belongs to this function rather than to its callers.
 */
function continuationPadding(text: string, from: number, end: number): number {
    let cursor = from;
    while (cursor < end && /[^\S\r\n]/.test(text[cursor])) cursor++;
    if (cursor >= end || (text[cursor] !== '\n' && text[cursor] !== '\r')) return cursor;
    cursor += text.startsWith('\r\n', cursor) ? 2 : 1;
    while (cursor < end && /[^\S\r\n]/.test(text[cursor])) cursor++;
    while (cursor < end && text[cursor] === '>') {
        cursor++;
        while (cursor < end && /[^\S\r\n]/.test(text[cursor])) cursor++;
    }
    return cursor;
}

/**
 * Offsets of the destination inside a definition the parser has already
 * delimited. The parser reports the node's range and the decoded URL but not the
 * destination's own span, and the raw-URL scans below must skip exactly the text
 * the destination check already covered — no more, so that a URL written inside
 * a label or a title stays subject to them. Returning nothing masks nothing,
 * which leaves those scans stricter rather than looser.
 */
function destinationSpan(
    text: string,
    start: number,
    end: number,
): { from: number; to: number } | undefined {
    let cursor = start + 1;
    while (cursor < end && text[cursor] !== ']') cursor += text[cursor] === '\\' ? 2 : 1;
    if (text[cursor] !== ']' || text[cursor + 1] !== ':') return undefined;
    cursor = continuationPadding(text, cursor + 2, end);
    if (text[cursor] === '<') {
        for (let scan = cursor + 1; scan < end; scan++) {
            if (text[scan] === '\\') {
                scan++;
                continue;
            }
            // An angle destination may not hold a line ending, so a '>' on a later
            // line closes something else — a container marker, most often. Stopping
            // here masks nothing rather than masking across it.
            if (text[scan] === '\n' || text[scan] === '\r') break;
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

interface InlineDestinationSpan {
    /** Offsets the destination itself spans, any padding whitespace skipped. */
    start: number;
    end: number;
}

interface InlineDestination extends InlineDestinationSpan {
    /** Destination as the parser decodes it: escapes and references resolved. */
    url: string;
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
): InlineDestinationSpan | undefined {
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
    cursor += 2;
    while (cursor < end && /\s/.test(text[cursor])) cursor++;
    return { start: cursor, end: cursor + inlineDestinationEnd(text.slice(cursor)) };
}

/** Inline links and images can sit at any depth, including inside a link label. */
function collectInlineLinks(node: Nodes, into: (Link | Image)[]): void {
    if (node.type === 'link' || node.type === 'image') into.push(node);
    if ('children' in node) for (const child of node.children) collectInlineLinks(child, into);
}

/**
 * Every link or image written in the `[label](destination)` form: where its
 * destination sits in `text`, and the URL the parser decodes that destination to.
 * Found with the parser the renderer runs rather than by looking for `](`.
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
    collectInlineLinks(parseMarkdown(text), nodes);
    return nodes.flatMap(({ position, url }) => {
        const start = position?.start.offset;
        const end = position?.end.offset;
        if (start === undefined || end === undefined) return [];
        const span = inlineDestination(text, start, end);
        return span === undefined ? [] : [{ ...span, url }];
    });
}

interface AutolinkLiteral {
    /** Offsets the address alone spans in `text`. */
    start: number;
    end: number;
    /** The address exactly as written, which is the form this syntax publishes. */
    address: string;
}

/**
 * Every GFM autolink literal in `text`: a bare address the renderer links with no
 * delimiters of its own, located with the parser the renderer runs.
 *
 * Where such a literal ends is the grammar's answer and nothing else's. The raw
 * URL scan below finds addresses by pattern and runs each one to the next space,
 * so a GFM closing run written against the address — `**Read <url>**`, `~~…~~`, a
 * bare trailing `*` — was read as URL characters and trimmed against a punctuation
 * class that does not contain them. The renderer publishes those delimiters
 * outside the anchor, so the reply cited exactly its evidence and was discarded
 * anyway, escalated to a human over a link the reader would have clicked through
 * to the cited source. Asking the grammar where the address ends removes the
 * class rather than adding characters to a class that keeps meeting new ones.
 *
 * Only the literal form is returned. A `[label](…)` destination, a reference
 * definition and a CommonMark `<…>` autolink each carry their own delimiters and
 * are already checked above, each in the form its own syntax publishes.
 */
function autolinkLiterals(text: string): AutolinkLiteral[] {
    const nodes: (Link | Image)[] = [];
    collectInlineLinks(parseMarkdown(text), nodes);
    return nodes.flatMap((node) => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (node.type !== 'link' || start === undefined || end === undefined) return [];
        const address = text.slice(start, end);
        return address.startsWith('[') || address.startsWith('<') ? [] : [{ start, end, address }];
    });
}

interface UriAutolink {
    /** Offsets the address alone spans in `text`, its '<' and '>' excluded. */
    start: number;
    end: number;
    /** The address exactly as written, which is the form this syntax publishes. */
    address: string;
}

/**
 * Every CommonMark `<…>` autolink in `text`: an absolute URI the grammar closes
 * on its own '>', located with the parser the renderer runs.
 *
 * This form was the one link syntax left to the pattern scans alone. They find an
 * address by pattern and run it to the next character outside a class, and that
 * class excludes `'` and '`' — characters `parseSourceUrl` accepts in an evidence
 * URL and this renderer publishes in an href, as `…/provider&#x27;s` and
 * `…/provider%60name`. So the scan read a prefix of the cited address, failed to
 * find that prefix in the evidence, and discarded a reply whose only citation was
 * its own evidence, in the one spelling that had no span to be masked by.
 *
 * Widening the class would have answered a different question than the
 * renderer's, and the class is what has already been wrong twice. Asking the
 * grammar where the autolink's address begins and ends removes it from the
 * question here too, exactly as `autolinkLiterals` did for the bare form.
 *
 * Only the `<…>` form is returned. The node range covers the delimiters, and what
 * the syntax publishes is the text between them; a reference, inline or bare
 * address starts with something else and is already located above, each in the
 * form its own syntax publishes.
 */
function uriAutolinks(text: string): UriAutolink[] {
    const nodes: (Link | Image)[] = [];
    collectInlineLinks(parseMarkdown(text), nodes);
    return nodes.flatMap((node) => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (node.type !== 'link' || start === undefined || end === undefined) return [];
        if (text[start] !== '<' || text[end - 1] !== '>') return [];
        return [{ start: start + 1, end: end - 1, address: text.slice(start + 1, end - 1) }];
    });
}

interface CodeSpanContents {
    /** Offsets the span encloses, relative to its own line, delimiters excluded. */
    from: number;
    to: number;
}

/** Code spans can sit at any depth, including inside a link label or a heading. */
function collectInlineCode(node: Nodes, into: InlineCode[]): void {
    if (node.type === 'inlineCode') into.push(node);
    if ('children' in node) for (const child of node.children) collectInlineCode(child, into);
}

/**
 * Per line of `text`, what each code span the grammar both opens and closes on
 * that line encloses — located with the parser the chat renderer runs, and
 * reported relative to the line's own start because the mask below runs a line at
 * a time.
 *
 * A span that closes on a later line is left out. Crossing a line can cross a
 * Markdown block boundary, so those stay conservatively subject to the prose
 * checks: deliberate, and unchanged.
 *
 * Offsets are taken from the node's own, not from its reported column, because a
 * tab advances a column by more than one character.
 */
function sameLineCodeSpanContents(text: string): CodeSpanContents[][] {
    const lineStarts: number[] = [];
    let offset = 0;
    for (const line of text.split('\n')) {
        lineStarts.push(offset);
        offset += line.length + 1;
    }
    const spans: CodeSpanContents[][] = lineStarts.map(() => []);
    const nodes: InlineCode[] = [];
    collectInlineCode(parseMarkdown(text), nodes);
    for (const { position } of nodes) {
        const start = position?.start.offset;
        const end = position?.end.offset;
        if (!position || start === undefined || end === undefined) continue;
        if (position.start.line !== position.end.line) continue;
        const lineStart = lineStarts[position.start.line - 1];
        // Opening and closing runs are the same length, so one measurement sizes
        // both, and what is left between them is exactly what the reader sees as
        // code.
        const delimiter = /^`+/.exec(text.slice(start, end))?.[0].length ?? 0;
        spans[position.start.line - 1].push({
            from: start - lineStart + delimiter,
            to: end - lineStart - delimiter,
        });
    }
    return spans;
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
 *
 * It asks through `parseMarkdown`, the one configuration in this file, so the
 * definitions masked here cannot drift from the destinations published below.
 */
function referenceDefinitions(text: string): ReferenceDefinition[] {
    const nodes: Definition[] = [];
    collectDefinitions(parseMarkdown(text), nodes);
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
 * What the reader is shown as prose: `line` with the contents of every code span
 * the grammar opens and closes on it blanked out.
 *
 * Which backtick runs pair is the grammar's question, and answering it here by
 * hand meant hand-parsing everything else that can hold a backtick without
 * opening a span. Each of those skips answered a different question than the
 * renderer's. Jumping from a '<' to the next '>' read `Compare <b, … and c>` as a
 * tag — the grammar closes none there, and publishes the span written between
 * them as <code> — so the scan stepped over that span and checked the example
 * address inside it as a citation the reader could click. The same jump could
 * land past a backtick instead, leaving the run after it to pair with a later
 * one, and the span that mispairing invented covered raw HTML the renderer
 * publishes as prose. A span the parser reports is neither, because a backtick
 * inside an attribute or a destination opens nothing it reports.
 *
 * Only what a span encloses is blanked, never its delimiters. The raw-HTML check
 * below re-reads this view, and `Use <b … > carefully.` — which the renderer
 * escapes whole, publishing no tag — becomes `Use <b   > carefully.` if the
 * backticks go with the contents, which the grammar does close into one. Blanking
 * in place also leaves every other offset on the line where the grammar found it.
 */
function proseOutsideInlineCode(line: string, spans: readonly CodeSpanContents[]): string {
    let prose = line;
    for (const { from, to } of spans) {
        prose = prose.slice(0, from) + ' '.repeat(to - from) + prose.slice(to);
    }
    return prose;
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
    const codeSpans = sameLineCodeSpanContents(fenced);
    const prose = fenced
        .split('\n')
        .map((line, index) =>
            definitionLines.has(index) ? line : proseOutsideInlineCode(line, codeSpans[index]),
        )
        .join('\n');
    const proseWithoutMarkdownDestinations = prose.split('');
    const maskMarkdownDestination = (start: number, end: number): void => {
        for (let index = start; index < end; index++) proseWithoutMarkdownDestinations[index] = ' ';
    };
    const checkUrl = (raw: string, allowProsePunctuation = false): void => {
        let candidate = raw;
        // Prose punctuation and Markdown closing delimiters are not URL content.
        // Try the full URL first, so a retrieved URL ending in ')' still works.
        while (candidate) {
            const canonical = canonicalSourceUrl(
                // GFM publishes a scheme-less `www.` host over http://, so that is
                // the destination to compare against; https:// would be invented.
                //
                // Which hosts carry that prefix is GFM's question, and it reads the
                // prefix in any case — as do both scans below. Reading it here in
                // lowercase alone left the two halves of this check disagreeing about
                // which addresses exist: a host written `WWW.` or `Www.` was found as
                // an address, reached this comparison with no scheme, parsed as
                // nothing, and was refused, while the grammar-derived destination for
                // the same sentence carried the http:// scheme and grounded. Only the
                // host is folded, and it is folded by the URL parser rather than
                // here, so a path or query that differs in case still differs.
                /^www\./i.test(candidate) ? `http://${candidate}` : candidate,
            );
            if (canonical && knownUrls.has(canonical)) return;
            if (!allowProsePunctuation || !/[.,;:!?)\]}]$/.test(candidate)) break;
            candidate = candidate.slice(0, -1);
        }
        throw new Error('Support reply link URL must belong to validated source evidence');
    };

    // Validate destinations separately so relative, protocol-relative, and
    // non-HTTP links cannot bypass the checks for raw URLs below. Each is compared
    // as the parser decodes it, because that is the value the renderer publishes:
    // it resolves both backslash escapes and HTML character references inside an
    // inline destination, so `…/search?a=1&amp;b=2` reaches the reader as
    // `…/search?a=1&b=2` — the same href the definition form below already
    // produced. Reading the inline form as spelled instead put the two spellings
    // of one published destination on opposite sides of this check, and discarded
    // a reply whose reader would have clicked through to the cited evidence.
    for (const { start, end, url } of inlineDestinations(prose)) {
        checkUrl(url);
        maskMarkdownDestination(start, end);
    }
    // Mask the destination alone: a label is not rendered, and leaving it visible
    // keeps a raw URL inside a multiline label subject to the checks below.
    for (const definition of referenceDefinitions(prose)) {
        checkUrl(definition.destination);
        maskMarkdownDestination(definition.destinationStart, definition.destinationEnd);
    }
    // A GFM autolink literal is held to the evidence set here, in the spelling the
    // reader clicks, and masked from the pattern scan below by the span the grammar
    // gives it. Checking before masking is what keeps the scan no looser than it
    // was: a literal the parser finds in a region that scan deliberately still
    // reaches — the contents of a code span crossing a line — stays refused.
    for (const { start, end, address } of autolinkLiterals(prose)) {
        checkUrl(address);
        maskMarkdownDestination(start, end);
    }
    // A CommonMark `<…>` autolink is held to the evidence on the same terms, in
    // the same spelling, and masked by the span the grammar gives its address
    // rather than by the pattern below — whose class stops at `'` and '`', both
    // of them ordinary evidence-URL content, and would otherwise re-read a
    // truncated prefix of an address this check has just accepted. The
    // delimiters stay visible: masking in place leaves every other offset where
    // the grammar found it, and the raw-HTML check below reads the unmasked
    // prose anyway. Checking before masking is again what keeps the scans no
    // looser than they were — an address the grammar does not close an autolink
    // around, in a code span crossing a line, is masked by nothing and stays
    // subject to them.
    for (const { start, end, address } of uriAutolinks(prose)) {
        checkUrl(address);
        maskMarkdownDestination(start, end);
    }
    const proseRawUrlView = proseWithoutMarkdownDestinations.join('');
    // Autolinks are the same question with a different answer, so they keep their
    // own comparison. This renderer publishes a CommonMark autolink's and a GFM
    // literal's address exactly as written — a character reference is left alone
    // there, `<…?a=1&amp;b=2>` links to `…?a=1&amp;b=2` — so decoding them the way
    // an inline destination is decoded would ground them on a URL no reader
    // reaches. These two scans compare the spelling because the reader clicks it.
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
    // The fields above are what the model wrote. This is what the reader receives:
    // publication trims `details` and normalizes and escapes `appliesTo`, so a
    // structure the checks above credited as inert can be gone by the time it is
    // published, and a destination they approved can reach the reader spelled
    // differently. Both happened. Checking the composed string holds every
    // transform standing between this function and the reader to the same
    // evidence, including whichever one is added next.
    validateProse(supportReplyDetails(parsed), knownUrls);
    return parsed;
}

/**
 * Escape the Markdown structure an applicability sentence could otherwise open.
 *
 * Only the characters that open an inline construct. The applicability publishes
 * mid-line, after `**Applies to:** `, where '-', '#' and '+' are a thematic
 * break, a heading and a list marker that can never start, and where '(' and ')'
 * mean nothing once the '[' and ']' that would have made them a destination are
 * escaped. Escaping them anyway cost fidelity without buying safety: each is
 * ordinary URL content, and '-' alone published the cited `…/reference/my-guide`
 * as `…/reference/my%5C-guide`.
 */
function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_[\]<>~|]/g, '\\$&');
}

interface ResolvedSpan {
    /** Offsets the whole link or image spans in the applicability line. */
    start: number;
    end: number;
    /** Every destination the span publishes, in order, nested ones included. */
    urls: string[];
    /**
     * Whether publishing the span hands the reader an `<img>`, which applicability
     * metadata never may — as an image, or by containing one at any depth.
     */
    image: boolean;
    /** Where the span writes its destinations, its nested ones included, in order. */
    destinations: InlineDestinationSpan[];
}

/**
 * Spans of every link and image the grammar resolves, in order and outermost
 * only, each with the destinations it publishes and the offsets it writes them at.
 *
 * A nested node already sits inside the span that contains it, and the caller
 * publishes a span as one piece, so returning one twice would duplicate the text
 * around it. What it publishes is still the enclosing span's to answer for: its
 * destinations belong to that span's `urls`, its offsets to that span's
 * `destinations`, and an image nested at any depth makes the whole span one that
 * publishes an `<img>`.
 *
 * That last part is why the node's own type is not the question. `[![d](a)](b)` is
 * one span whose outermost node is a link, and copying it through as a link
 * published the image inside it — the surface this field never publishes, reached
 * past a check that had only ever asked what the outermost node was.
 */
function resolvedSpans(text: string): ResolvedSpan[] {
    const nodes: (Link | Image)[] = [];
    collectInlineLinks(parseMarkdown(text), nodes);
    const located = nodes.flatMap((node) => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        return start === undefined || end === undefined ? [] : [{ node, start, end }];
    });
    located.sort((first, second) => first.start - second.start || second.end - first.end);
    const outermost: ResolvedSpan[] = [];
    for (const { node, start, end } of located) {
        const destination = inlineDestination(text, start, end);
        const enclosing = outermost.at(-1);
        if (enclosing !== undefined && start < enclosing.end) {
            if (node.type === 'image') enclosing.image = true;
            if (destination) enclosing.destinations.push(destination);
            continue;
        }
        const urls: string[] = [];
        collectDestinations(node, urls);
        outermost.push({
            start,
            end,
            urls,
            image: node.type === 'image',
            destinations: destination ? [destination] : [],
        });
    }
    // An outer node is reported before the nodes inside it, so its own destination
    // is collected first while it is written last. The caller walks the span from
    // left to right, which is the order it needs them in.
    for (const span of outermost) {
        span.destinations.sort((first, second) => first.start - second.start);
    }
    return outermost;
}

/** The `<…>` autolink's own production: it carries an absolute URI and nothing else. */
const ABSOLUTE_URI = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/;

/**
 * A bare address written so the grammar closes its extent for us: the CommonMark
 * `<…>` autolink, which ends on its own '>' rather than at the next space, and
 * publishes the destination it carries as both href and visible text.
 *
 * An address that is already an absolute URI goes inside the brackets as written,
 * so both stay exactly what the reply cited. A scheme-less `www.` host cannot —
 * angle brackets around one publish as part of the address — and leaving it at
 * that refused a reply whose only citation was its own evidence, which is the
 * escalation this whole transform exists to stop. So the address is put back to
 * the grammar: the destination it publishes for a `www.` host is that host over
 * http://, an absolute URI the autolink does carry. The scheme is the parser's
 * answer and never an invented https://, and the reader sees that published
 * destination rather than the scheme-less spelling — the one fidelity this form
 * cannot keep, and the reason it is used only where the address needs bounding.
 *
 * The `[address](<destination>)` spelling would have kept it, and is refused by
 * this module's own final validation: the label puts a bare address immediately
 * against the `](` that follows it, and the raw-URL scan reads the pair as part of
 * the address. Preferring it would mean loosening that scan, so it is not written.
 *
 * Anything else — a relative destination, an address the grammar publishes no
 * single absolute destination for — is returned unchanged, which leaves the
 * composed check to refuse it rather than publishing a rewrite.
 */
function boundedAutolink(address: string): string {
    if (ABSOLUTE_URI.test(address)) return `<${address}>`;
    const [published, ...rest] = publishedDestinations(address);
    return rest.length === 0 && published !== undefined && ABSOLUTE_URI.test(published)
        ? `<${published}>`
        : address;
}

/**
 * One candidate spelling of the applicability line: the spans the grammar
 * resolves published as links, the text between them escaped, and — when
 * `boundAddresses` is set — every bare address rewritten into the form whose
 * extent the grammar closes.
 *
 * A span that publishes an image is not published as one, whether it is the image
 * or merely holds it. Its syntax is escaped like any other structure the model
 * wrote, so no `<img>` and no remote fetch reaches the reader, but every
 * destination written inside it is copied through — the nested one included —
 * because escaping the address is what rewrote a cited URL in the first place.
 */
function composeAppliesTo(line: string, spans: ResolvedSpan[], boundAddresses: boolean): string {
    const address = (text: string) => (boundAddresses ? boundedAutolink(text) : text);
    let published = '';
    let cursor = 0;
    for (const span of spans) {
        const whole = line.slice(span.start, span.end);
        // A span published as a link keeps its own '[', and '!' immediately before
        // one is what makes it an image — the single adjacency where a character
        // outside a span changes what the span publishes. '!' is not structure on
        // its own, so the escape leaves it alone, and it can only arrive in this
        // position written '\!', whose protecting backslash the escape has just
        // turned into a literal one. Escaped here, it publishes as the '!' it is.
        const prefix = escapeMarkdown(line.slice(cursor, span.start));
        published +=
            !span.image && whole.startsWith('[') && prefix.endsWith('!')
                ? `${prefix.slice(0, -1)}\\!`
                : prefix;
        if (!span.image) {
            // `[label](…)` and `<…>` close on their own delimiter; a bare literal
            // runs to the next space, so it is the only form that needs bounding.
            published += whole.startsWith('[') || whole.startsWith('<') ? whole : address(whole);
        } else {
            // Escaped, the destinations stop being destinations: they are bare text
            // the grammar relinkifies, so each one needs the same bounding a bare
            // address does. A span writing none is escaped whole.
            let inner = span.start;
            for (const destination of span.destinations) {
                published +=
                    escapeMarkdown(line.slice(inner, destination.start)) +
                    address(line.slice(destination.start, destination.end));
                inner = destination.end;
            }
            published += escapeMarkdown(line.slice(inner, span.end));
        }
        cursor = span.end;
    }
    return published + escapeMarkdown(line.slice(cursor));
}

/**
 * The applicability sentence in the exact form the reply publishes it: normalized
 * onto the single line it renders on, its Markdown structure escaped, and the
 * links the grammar resolves left as the model wrote them.
 *
 * The escape used to run over every character, and an address is spelled out of
 * the characters Markdown punctuates with. A cited URL came out rewritten — the
 * evidence check approved one address and the reader clicked another — and a
 * `[label](…)` citation escaped into plain URL text is relinkified by GFM onto
 * that same rewritten address, so escaping a link neither removed it nor kept it.
 * A span the grammar already publishes as a link is therefore copied through
 * untouched, and the escape runs between those spans, where a stray '[' or '`'
 * really would invent structure a reader can act on.
 *
 * Escaping between the spans is not free of them, though, and that is what this
 * function has to settle. A backslash escape is not a character a GFM autolink
 * literal ends on, so the grammar reads one written against an address as more of
 * the address: the emphasis run the renderer publishes outside the anchor came
 * back inside it once escaped, and `…/reference/my-guide` published as
 * `…/reference/my-guide\*\`. Rather than decide which escapes the literal's
 * trailing-punctuation rule happens to discard — the punctuation class this file
 * has already removed twice — the composed line is handed back to the grammar: if
 * it no longer publishes the destinations its spans do, every bare address is
 * rewritten into the `<…>` autolink the grammar closes for us, and nothing else
 * moves. `validateSupportReply` checks the result either way, so a line that
 * still does not agree is refused rather than published as a rewrite.
 */
function publishedAppliesTo(text: string): string {
    const line = text.replace(/\s+/g, ' ').trim();
    const spans = resolvedSpans(line);
    const cited = spans.flatMap((span) => span.urls);
    const published = composeAppliesTo(line, spans, false);
    const destinations = publishedDestinations(published);
    const agrees =
        destinations.length === cited.length && destinations.every((url, at) => url === cited[at]);
    return agrees ? published : composeAppliesTo(line, spans, true);
}

/**
 * Trim the blank edges of `details` without moving its first line.
 *
 * `.trim()` moved it, and indentation is block structure: four leading spaces are
 * an indented code block, which is why the evidence check credits an address
 * inside one as inert, and removing them republished that block as a paragraph
 * with a live link in it. Whole blank lines above and whitespace below carry no
 * block structure, so they still go.
 */
function trimBlankEdges(text: string): string {
    return text.replace(/^(?:[^\S\n]*\n)+/, '').replace(/\s+$/, '');
}

/**
 * A URL written so an inline destination decodes back to it. The renderer
 * resolves HTML character references inside a destination, so a cited address
 * holding one — `…/search?a=1&amp;b=2` — published as the address that reference
 * decodes to, and "Source 1" led somewhere the evidence never said. A destination
 * cannot carry whitespace, '<', '>', '"' or '\' either, but `parseSourceUrl` has
 * already refused an evidence URL holding any of those, so the character
 * reference is the one spelling left to preserve.
 */
function escapeDestination(url: string): string {
    return url.replace(/&/g, '&amp;');
}

/** Evidence quotes establish grounding internally; public replies link the sources once. */
export function supportReplyDetails(reply: SupportReply): string {
    if (reply.decision === 'route') return '';
    const parts = [trimBlankEdges(reply.details)];
    if (reply.appliesTo.trim())
        parts.push(`**Applies to:** ${publishedAppliesTo(reply.appliesTo)}`);
    parts.push(`**API version:** ${reply.apiVersion}`);
    const urls = [...new Set(reply.evidence.map((evidence) => evidence.sourceUrl))];
    if (urls.length) {
        parts.push(
            '**Sources**\n\n' +
                urls
                    .map((url, index) => `- [Source ${index + 1}](<${escapeDestination(url)}>)`)
                    .join('\n'),
        );
    }
    return parts.filter(Boolean).join('\n\n');
}

/** Text for grounding and linting includes the citations the user will see. */
export function supportReplyText(reply: SupportReply): string {
    return [reply.summary, supportReplyDetails(reply)].filter(Boolean).join('\n\n');
}

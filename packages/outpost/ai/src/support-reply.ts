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

/** Preserve code verbatim for rendering, but do not interpret example URLs as citations. */
function proseOutsideFences(text: string): string {
    let fence: string | undefined;
    const prose: string[] = [];
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
            if (
                marker &&
                marker[1][0] === fence[0] &&
                marker[1].length >= fence.length &&
                !marker[2].trim()
            ) {
                fence = undefined;
            }
            prose.push('');
        } else if (marker) {
            if (marker[1][0] === '`' && marker[2].includes('`')) {
                throw new Error('Invalid code fence in support reply');
            }
            fence = marker[1];
            prose.push('');
        } else {
            prose.push(line);
        }
    }
    if (fence) throw new Error('Unclosed code fence in support reply');
    return prose.join('\n');
}

/** Between the brackets of a link label CommonMark allows at most 999 characters. */
const REFERENCE_LABEL_LIMIT = 999;

interface ReferenceDefinition {
    /** Inclusive line range the whole definition occupies. */
    firstLine: number;
    lastLine: number;
    destination: string;
    destinationStart: number;
    destinationEnd: number;
}

/**
 * Recognize a link reference definition beginning at `start`, which must be the
 * start of line `firstLine`. A label ends at the first right bracket that is not
 * backslash-escaped and may span lines, so no single-line pattern can bound one;
 * missing those labels would leave their destinations unvalidated even though the
 * renderer resolves them to clickable links. Stay at least as permissive as
 * CommonMark: the controls enforced here are only the ones that make the renderer
 * produce no definition at all, and therefore no link.
 */
function referenceDefinitionAt(
    text: string,
    start: number,
    firstLine: number,
): ReferenceDefinition | undefined {
    let cursor = start;
    for (let indent = 0; indent < 3 && text[cursor] === ' '; indent++) cursor++;
    if (text[cursor] !== '[') return undefined;

    cursor++;
    let line = firstLine;
    const labelStart = cursor;
    while (cursor < text.length && text[cursor] !== ']') {
        if (cursor - labelStart >= REFERENCE_LABEL_LIMIT) return undefined;
        // A backslash at the end of a line escapes nothing, so let the line
        // ending below decide whether the label continues.
        if (text[cursor] === '\\' && text[cursor + 1] !== '\n') {
            cursor += 2;
            continue;
        }
        if (text[cursor] === '\n') {
            line++;
            // A blank line ends the label, leaving no definition behind.
            let ahead = cursor + 1;
            while (text[ahead] === ' ' || text[ahead] === '\t') ahead++;
            if (ahead >= text.length || text[ahead] === '\n') return undefined;
        }
        cursor++;
    }
    if (text[cursor] !== ']' || text[cursor + 1] !== ':') return undefined;
    cursor += 2;

    // Spaces or tabs reach the destination, across at most one line ending.
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor++;
    if (text[cursor] === '\n') {
        cursor++;
        line++;
        while (text[cursor] === ' ' || text[cursor] === '\t') cursor++;
    }

    const destinationStart = cursor;
    if (text[destinationStart] === '<') {
        for (let scan = destinationStart + 1; scan < text.length; scan++) {
            if (text[scan] === '\n') break;
            if (text[scan] === '\\' && text[scan + 1] !== '\n') {
                scan++;
                continue;
            }
            if (text[scan] === '>') {
                return {
                    firstLine,
                    lastLine: line,
                    destination: text.slice(destinationStart + 1, scan),
                    destinationStart,
                    destinationEnd: scan + 1,
                };
            }
        }
        // An angle destination never spans a line ending. Fall through so an
        // unterminated one is still checked as the run of characters it is.
    }
    let destinationEnd = destinationStart;
    while (destinationEnd < text.length && !/\s/.test(text[destinationEnd])) destinationEnd++;
    if (destinationEnd === destinationStart) return undefined;
    return {
        firstLine,
        lastLine: line,
        destination: text.slice(destinationStart, destinationEnd),
        destinationStart,
        destinationEnd,
    };
}

/** Every line start in `text` that begins a link reference definition. */
function referenceDefinitions(text: string): ReferenceDefinition[] {
    const definitions: ReferenceDefinition[] = [];
    let lineStart = 0;
    for (const [line, source] of text.split('\n').entries()) {
        const definition = referenceDefinitionAt(text, lineStart, line);
        if (definition) definitions.push(definition);
        lineStart += source.length + 1;
    }
    return definitions;
}

/**
 * Exclude same-line code spans only. Crossing a line can cross a Markdown block
 * boundary, so multiline spans remain conservatively subject to prose checks.
 * Closing runs must match the opening length; backslashes are literal in code.
 */
function proseOutsideInlineCode(line: string): string {
    let cursor = 0;
    let preserved = 0;
    let prose = '';
    while (cursor < line.length) {
        if (line[cursor] === '\\') {
            cursor += 2;
            continue;
        }
        if (/^<(?:!|\?|\/?[a-z])/i.test(line.slice(cursor))) {
            const end = line.indexOf('>', cursor);
            cursor = end < 0 ? line.length : end + 1;
            continue;
        }
        if (line.startsWith('](', cursor)) {
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
    const prose = fenced
        .split('\n')
        .map((line, index) => (definitionLines.has(index) ? line : proseOutsideInlineCode(line)))
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
                candidate.startsWith('www.') ? `https://${candidate}` : candidate,
            );
            if (canonical && knownUrls.has(canonical)) return;
            if (!allowProsePunctuation || !/[.,;:!?)\]}]$/.test(candidate)) break;
            candidate = candidate.slice(0, -1);
        }
        throw new Error('Support reply link URL must belong to validated source evidence');
    };

    // Validate destinations separately so relative, protocol-relative, and
    // non-HTTP links cannot bypass the checks for raw URLs below.
    for (const match of prose.matchAll(/\]\(\s*/g)) {
        const destinationStart = match.index + match[0].length;
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
        checkUrl(definition.destination, false, true);
        maskMarkdownDestination(definition.destinationStart, definition.destinationEnd);
    }
    const proseRawUrlView = proseWithoutMarkdownDestinations.join('');
    for (const match of proseRawUrlView.matchAll(/<(https?:\/\/[^\s<>]+)>/gi)) {
        checkUrl(match[1]);
    }
    for (const match of proseRawUrlView.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi)) {
        checkUrl(match[0], true);
    }

    const withoutAutolinks = prose.replace(/<https?:\/\/[^\s<>]+>/gi, '');
    if (/<(?:!|\?|\/?[a-z])/i.test(withoutAutolinks)) {
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

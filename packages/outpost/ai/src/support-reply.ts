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

/** Source citations must be absolute HTTP(S) URLs without embedded credentials. */
function parseSourceUrl(value: string): URL | undefined {
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

/**
 * Exclude same-line code spans only. Crossing a line can cross a Markdown block
 * boundary, so multiline spans remain conservatively subject to prose checks.
 * Closing runs must match the opening length; backslashes are literal in code.
 */
function proseOutsideInlineCode(line: string): string {
    // Backticks in a link definition or destination are URL characters, not code.
    if (/^ {0,3}\[[^\]\n]+\]:/.test(line)) return line;
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
            let depth = 1;
            cursor += 2;
            while (cursor < line.length && depth) {
                if (line[cursor] === '(') depth++;
                if (line[cursor] === ')') depth--;
                cursor++;
            }
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
    const prose = proseOutsideFences(text).split('\n').map(proseOutsideInlineCode).join('\n');
    const checkUrl = (raw: string, allowProsePunctuation = false): void => {
        let candidate = raw;
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
        const destination = prose.slice(match.index + match[0].length);
        if (destination.startsWith('<')) {
            checkUrl(destination.slice(1, destination.indexOf('>')));
            continue;
        }
        let depth = 0;
        let end = 0;
        for (; end < destination.length; end++) {
            const character = destination[end];
            if (/\s/.test(character) || (character === ')' && depth === 0)) break;
            if (character === '(') depth++;
            if (character === ')') depth--;
        }
        checkUrl(destination.slice(0, end));
    }
    for (const match of prose.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]*)>|(\S+))/gm)) {
        checkUrl(match[1] ?? match[2]);
    }
    for (const match of prose.matchAll(/<(https?:\/\/[^\s<>]+)>/gi)) {
        checkUrl(match[1]);
    }
    for (const match of prose.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi)) {
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

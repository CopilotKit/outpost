/**
 * Inbound-text hygiene — shared by every platform.
 *
 * Raw message bodies arrive full of platform markup (Discord mention/emoji
 * tokens, Slack link syntax) and issue-template boilerplate (pre-flight
 * checklists, HTML comments, pasted channel sidebars). None of it is signal:
 * forwarded verbatim it dilutes docs-search embeddings and pads generation
 * prompts. The only sanitizer that existed before this ran on the OUTBOUND
 * reply (see ai/formatter.ts), so nothing cleaned the inbound side.
 *
 * Everything here is pure and dependency-free so bots, the queue, and the AI
 * package can all share it.
 */

/** Discord custom emoji: `<:name:id>` / `<a:name:id>` (animated). */
const DISCORD_CUSTOM_EMOJI = /<a?:[a-z0-9_]+:\d+>/gi;

/** Discord channel mention: `<#123>`. */
const DISCORD_CHANNEL_MENTION = /<#\d+>/g;

/** Discord user/role mention: `<@123>`, `<@!123>`, `<@&123>`. */
const DISCORD_USER_MENTION = /<@[!&]?\d+>/g;

/** Discord relative timestamp: `<t:1738000000:R>`. */
const DISCORD_TIMESTAMP = /<t:\d+(?::[tTdDfFR])?>/g;

/** Slack channel mention with label: `<#C123|general>` -> `general`. */
const SLACK_CHANNEL_MENTION = /<#[CG][A-Z0-9]+\|([^>]*)>/g;

/** Slack user or user-group mention: `<@U123>`, `<@W123|name>`. */
const SLACK_USER_MENTION = /<@[UWG][A-Z0-9]+(?:\|[^>]*)?>/g;

/** Slack broadcast: `<!here>`, `<!channel>`, `<!subteam^S123|@team>`. */
const SLACK_BROADCAST = /<!(?:here|channel|everyone|subteam\^[A-Z0-9]+)(?:\|[^>]*)?>/gi;

/** Slack link with label: `<https://x|label>` -> `label`. */
const SLACK_LABELLED_LINK = /<(https?:\/\/[^|>\s]+)\|([^>]*)>/g;

/** Slack bare link: `<https://x>` -> `https://x`. */
const SLACK_BARE_LINK = /<(https?:\/\/[^>\s]+)>/g;

/** Emoji shortcode standing alone as a token: ` :wave: `. */
const EMOJI_SHORTCODE = /(^|\s):[a-z0-9_+-]{2,32}:(?=\s|$)/gi;

/** HTML comment — issue templates hide their instructions in these. */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** Markdown task-list line: `- [x] I have searched existing issues`. */
const TASK_LIST_LINE = /^\s*[-*]\s*\[[ xX]\]\s.*$/;

/**
 * Zero-width joiners and variation selectors. Dropped up front so the
 * decoration patterns below can reason about single code points.
 */
const ZERO_WIDTH = /\u200D|[\uFE00-\uFE0F]/g;

/** Leading markdown heading markers plus any decorative emoji: `### <emoji> Steps`. */
const HEADING_PREFIX = /^\s{0,3}#{1,6}[\s\p{Extended_Pictographic}]*/u;

/**
 * A line made up only of decoration — symbols, punctuation, and the box-drawing
 * glyphs Discord uses in its channel sidebar, with no words. The ranges are
 * U+2000-206F general punctuation and U+2190-2BFF arrows through miscellaneous
 * symbols, which covers box drawing at U+2500-257F.
 */
const DECORATION_ONLY_LINE =
    /^[\s#*>|\-_=~.,:;!?()[\]{}\u2000-\u206F\u2190-\u2BFF\p{Extended_Pictographic}]*$/u;

/**
 * A pasted Discord channel-sidebar row. The leading vertical box-drawing glyph
 * (U+2502-254B) and the speaker emoji (U+1F508-1F50A, U+1F4E2) are the sidebar's
 * own decoration — no prose line starts with either.
 */
const SIDEBAR_ROW = /^[\s#*>-]*(?:[\u2502-\u254B]|[\u{1F4E2}\u{1F508}-\u{1F50A}])\s*\S/u;

/**
 * Issue-template section headings that never carry the reporter's question.
 * Matched case-insensitively against the heading text after markers and emoji
 * are stripped. Deliberately short — headings like "Reproduction Steps" or
 * "Describe the bug" DO carry signal and must survive.
 */
const BOILERPLATE_HEADINGS = new Set([
    'pre-flight checklist',
    'preflight checklist',
    'checklist',
    'code of conduct',
    'terms',
    'prerequisites',
]);

/**
 * Strip platform markup and issue-template boilerplate from an inbound message
 * body, leaving the reporter's own prose and code intact.
 *
 * Conservative by design: it removes tokens that are unambiguously markup, not
 * anything that might be content. Semantic narrowing (picking the actual
 * question out of a long post) is a separate concern — see the AI package's
 * SearchQueryBuilder.
 */
export function sanitizePlatformMarkup(text: string): string {
    if (!text) return '';

    const stripped = text
        .replace(ZERO_WIDTH, '')
        .replace(HTML_COMMENT, ' ')
        .replace(SLACK_LABELLED_LINK, '$2')
        .replace(SLACK_BARE_LINK, '$1')
        .replace(SLACK_CHANNEL_MENTION, '$1')
        .replace(SLACK_USER_MENTION, ' ')
        .replace(SLACK_BROADCAST, ' ')
        .replace(DISCORD_CUSTOM_EMOJI, ' ')
        .replace(DISCORD_CHANNEL_MENTION, ' ')
        .replace(DISCORD_USER_MENTION, ' ')
        .replace(DISCORD_TIMESTAMP, ' ')
        .replace(EMOJI_SHORTCODE, '$1');

    const kept: string[] = [];
    let insideCodeFence = false;

    for (const line of stripped.split('\n')) {
        // Code fences are content — pass every line through untouched while open.
        if (/^\s*```/.test(line)) {
            insideCodeFence = !insideCodeFence;
            kept.push(line);
            continue;
        }
        if (insideCodeFence) {
            kept.push(line);
            continue;
        }

        if (TASK_LIST_LINE.test(line)) continue;
        if (SIDEBAR_ROW.test(line)) continue;

        const headingPrefix = line.match(HEADING_PREFIX)?.[0];
        if (headingPrefix !== undefined && headingPrefix.trimStart().startsWith('#')) {
            const headingText = line.slice(headingPrefix.length).trim();
            if (BOILERPLATE_HEADINGS.has(headingText.toLowerCase())) continue;
            if (headingText) kept.push(headingText);
            continue;
        }

        if (line.trim() && DECORATION_ONLY_LINE.test(line)) continue;

        kept.push(line);
    }

    // Collapse the runs of blank lines and spaces the removals left behind.
    return kept
        .join('\n')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/ +\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Phrasings that mark a message as asking for help rather than announcing. */
const HELP_PATTERNS: RegExp[] = [
    /\b(how (do|can|to|would|should)|what('s| is| are)|is there|is it possible|any (idea|one|body)|does any)/i,
    /\b(help|stuck|confused|struggling|trying to|unable to|can'?t|cannot|won'?t|doesn'?t|didn'?t)\b/i,
    /\b(not working|no luck|fails?|failing|failed|broken|crash(es|ing)?|hangs?)\b/i,
    /\b(error|exception|traceback|stack ?trace)\b/i,
    /\b(expected .{0,40}(but|instead)|instead of|but it|however it)\b/i,
    /(TypeError|ReferenceError|SyntaxError|RangeError|ENOENT|ECONNREFUSED)/,
    /^\s*at\s+\S+\s*\(.*:\d+:\d+\)/m,
];

/**
 * Decide whether an inbound message is a support request worth spending a full
 * retrieval + generation cycle on.
 *
 * Deliberately permissive — a missed announcement costs nothing, a missed
 * support request costs a customer. Anything with a question mark, a help
 * phrasing, an error signature, or a direct @-mention of the bot qualifies.
 */
export function isSupportRequest(content: string, options?: { botUserId?: string }): boolean {
    // The bot-mention check runs on the RAW text: sanitizing strips mentions.
    if (options?.botUserId && new RegExp(`<@[!&]?${options.botUserId}>`).test(content)) {
        return true;
    }

    const cleaned = sanitizePlatformMarkup(content);
    if (!cleaned) return false;

    if (cleaned.includes('?')) return true;

    return HELP_PATTERNS.some((pattern) => pattern.test(cleaned));
}

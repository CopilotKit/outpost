/**
 * Ingress limits for POST /api/qa.
 *
 * The question and history are concatenated into the Anthropic prompt, so an
 * unbounded request is a direct line to the model bill. These caps keep a
 * single request to a predictable token budget.
 *
 * Lives here (not in the route) because Next's App Router only permits HTTP
 * verbs and a fixed set of config fields as route exports — exporting these
 * so tests can import them breaks `next build` and `tsc`.
 */
export const MAX_QUESTION_CHARS = 4000;
export const MAX_HISTORY_ITEMS = 20;
export const MAX_HISTORY_ITEM_CHARS = 4000;
export const MAX_HISTORY_TOTAL_CHARS = 12000;

export type HistoryRole = 'user' | 'assistant';

export interface HistoryItem {
    role: HistoryRole;
    content: string;
}

/**
 * Validate the optional conversation history. Returns the sanitized history,
 * or an error message naming the first problem found.
 */
export function sanitizeHistory(
    raw: unknown,
): { ok: true; history: HistoryItem[] | undefined } | { ok: false; error: string } {
    if (raw === undefined || raw === null) {
        return { ok: true, history: undefined };
    }
    if (!Array.isArray(raw)) {
        return { ok: false, error: 'conversationHistory must be an array' };
    }
    if (raw.length > MAX_HISTORY_ITEMS) {
        return {
            ok: false,
            error: `conversationHistory must have at most ${MAX_HISTORY_ITEMS} items`,
        };
    }
    const history: HistoryItem[] = [];
    let totalChars = 0;
    for (let i = 0; i < raw.length; i++) {
        const item = raw[i] as { role?: unknown; content?: unknown };
        if (typeof item !== 'object' || item === null) {
            return { ok: false, error: `conversationHistory[${i}] must be an object` };
        }
        if (item.role !== 'user' && item.role !== 'assistant') {
            return {
                ok: false,
                error: `conversationHistory[${i}].role must be "user" or "assistant"`,
            };
        }
        if (typeof item.content !== 'string' || item.content.trim() === '') {
            return {
                ok: false,
                error: `conversationHistory[${i}].content must be a non-empty string`,
            };
        }
        const content = item.content.trim();
        if (content.length > MAX_HISTORY_ITEM_CHARS) {
            return {
                ok: false,
                error: `conversationHistory[${i}].content must be at most ${MAX_HISTORY_ITEM_CHARS} characters`,
            };
        }
        totalChars += content.length;
        if (totalChars > MAX_HISTORY_TOTAL_CHARS) {
            return {
                ok: false,
                error: `conversationHistory must total at most ${MAX_HISTORY_TOTAL_CHARS} characters`,
            };
        }
        history.push({ role: item.role, content });
    }
    return { ok: true, history: history.length > 0 ? history : undefined };
}

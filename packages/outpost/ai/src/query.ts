import Anthropic from '@anthropic-ai/sdk';
import { sanitizePlatformMarkup } from '@copilotkit/outpost/shared';
import type { TokenUsage } from './types.js';
import { config } from './config.js';

const DISTILL_SYSTEM_PROMPT = `You turn a raw customer support message into a documentation search query for CopilotKit, an open-source AI framework.

Respond with ONLY the search query — no quotes, no preamble, no explanation.

Rules:
- Capture what the person is actually trying to do or what is failing.
- Keep the specific API names, package names, error types, and framework names they mentioned.
- Drop greetings, pleasantries, issue-template boilerplate, environment dumps, stack traces, and anything pasted by accident.
- Write it as a short natural-language query, not keywords separated by commas.
- Maximum 30 words. If the message asks several things, cover the primary one.`;

/**
 * A message this short and this plain is already a usable query — distilling it
 * would cost a round trip to say the same thing back.
 */
const DISTILL_SKIP_CHARS = 200;

/** Hard cap on the query handed to Pathfinder, whatever produced it. */
const MAX_QUERY_CHARS = 300;

/** Result of turning a raw inbound body into a docs-search query. */
export interface SearchQuery {
    /** The focused query to send to Pathfinder. */
    query: string;
    /** The full message with platform markup and boilerplate removed. */
    sanitized: string;
    /** True when the LLM distiller was unavailable and the heuristic ran instead. */
    degraded: boolean;
    tokenUsage: TokenUsage;
}

/** Fenced and inline code — signal for the answer, noise for the embedder. */
const CODE_FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]+`/g;
const BARE_URL = /https?:\/\/\S+/g;
const STACK_FRAME = /^\s*at\s+\S+.*$/gm;

/**
 * Build a docs-search query from a sanitized body without calling an LLM.
 *
 * Prefers the sentences that carry a question mark — in a long forum post the
 * question is almost always the part with the `?` — and otherwise falls back to
 * the opening prose.
 */
export function heuristicSearchQuery(sanitized: string): string {
    const prose = sanitized
        .replace(CODE_FENCE, ' ')
        .replace(STACK_FRAME, ' ')
        .replace(INLINE_CODE, ' ')
        .replace(BARE_URL, ' ')
        .replace(/[^\S\n]+/g, ' ')
        .trim();

    if (!prose) return '';

    // Split on blank lines first: a paragraph break ends a thought, but a bare
    // newline usually does not — hard-wrapped issue bodies routinely break a
    // single question across two lines.
    const sentences = prose
        .split(/\n\s*\n/)
        .flatMap((paragraph) => {
            const joined = paragraph.replace(/\s+/g, ' ').trim();
            return joined.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
        })
        .map((sentence) => sentence.trim())
        .filter(Boolean);

    if (sentences.length === 0) return truncateQuery(prose.replace(/\s+/g, ' '));

    const questions = sentences.filter((sentence) => sentence.includes('?'));
    const picked = questions.length > 0 ? questions : sentences;

    return truncateQuery(picked.join(' ').replace(/\s+/g, ' ').trim());
}

/** Trim to MAX_QUERY_CHARS on a word boundary. */
function truncateQuery(query: string): string {
    if (query.length <= MAX_QUERY_CHARS) return query;
    const clipped = query.slice(0, MAX_QUERY_CHARS);
    const lastSpace = clipped.lastIndexOf(' ');
    return (lastSpace > MAX_QUERY_CHARS / 2 ? clipped.slice(0, lastSpace) : clipped).trim();
}

/**
 * Turns a raw inbound message body into a focused documentation-search query.
 *
 * Two stages, mirroring TicketClassifier's shape: sanitize the platform markup
 * deterministically, then distill the remaining prose with Claude Haiku, with a
 * heuristic fallback so retrieval never fails just because the LLM is down.
 *
 * Without this the entire body — up to 8000 characters of mentions, sidebar
 * pastes, and checklist boilerplate — was embedded as the search query.
 */
export class SearchQueryBuilder {
    private client: Anthropic;
    private model: string;

    constructor(options?: { apiKey?: string; model?: string }) {
        this.client = new Anthropic({
            apiKey: options?.apiKey ?? config.anthropicApiKey,
        });
        this.model = options?.model ?? config.queryDistillerModel;
    }

    /**
     * Sanitize, then distill. Never throws — a failed distillation degrades to
     * the heuristic rather than dropping the search.
     */
    async build(rawQuestion: string): Promise<SearchQuery> {
        const sanitized = sanitizePlatformMarkup(rawQuestion);
        const noTokens: TokenUsage = { inputTokens: 0, outputTokens: 0 };

        if (!sanitized) {
            return { query: '', sanitized, degraded: false, tokenUsage: noTokens };
        }

        // Short, already-focused messages are their own best query.
        if (sanitized.length <= DISTILL_SKIP_CHARS) {
            return {
                query: truncateQuery(sanitized.replace(/\s+/g, ' ')),
                sanitized,
                degraded: false,
                tokenUsage: noTokens,
            };
        }

        try {
            const message = await this.client.messages.create({
                model: this.model,
                max_tokens: config.maxQueryDistillerTokens,
                temperature: config.queryDistillerTemperature,
                system: DISTILL_SYSTEM_PROMPT,
                messages: [{ role: 'user', content: sanitized.slice(0, 4000) }],
            });

            const text = message.content[0]?.type === 'text' ? message.content[0].text : '';
            const distilled = truncateQuery(text.replace(/\s+/g, ' ').trim());

            if (!distilled) {
                throw new Error('distiller returned an empty query');
            }

            return {
                query: distilled,
                sanitized,
                degraded: false,
                tokenUsage: {
                    inputTokens: message.usage.input_tokens,
                    outputTokens: message.usage.output_tokens,
                },
            };
        } catch (error) {
            console.error(
                `[SearchQuery] Distillation failed, falling back to heuristic: ${error instanceof Error ? error.message : String(error)}`,
            );
            return {
                query: heuristicSearchQuery(sanitized),
                sanitized,
                degraded: true,
                tokenUsage: noTokens,
            };
        }
    }
}

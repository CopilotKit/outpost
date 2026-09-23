import { z, ZodError } from 'zod';
import {
    TicketStatus,
    TicketPriority,
    TicketType,
    TicketSource,
    BroadcastAudience,
    BroadcastStatus,
} from '@copilotkit/outpost/db';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@copilotkit/outpost/shared';

/**
 * Shared input validation for the web API routes.
 *
 * Before this module, routes cast query/body values straight to Prisma enums
 * (`status as TicketStatus[]`) and accepted unbounded strings. A single bad
 * enum value became a Prisma throw (HTTP 500) and an oversized payload was
 * written to the database unchecked. Every schema here maps failures to a
 * 400 with a message that names the offending field.
 */

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 20000;
export const MAX_CONTENT_LENGTH = 100000;
export const MAX_SEARCH_LENGTH = 200;
export const MAX_URL_LENGTH = 2048;
export const MAX_ID_LENGTH = 100;
export const MAX_BROADCAST_LENGTH = 500;

const nonEmptyTrimmed = (max: number) =>
    z.string().trim().min(1, 'must not be empty').max(max, `must be at most ${max} characters`);

/** Parse a repeated enum query param; unknown values are reported, not cast. */
function enumFilter<E extends Record<string, string>>(enumObj: E, field: string) {
    const values = Object.values(enumObj) as string[];
    return {
        parseAll(raw: string[]): { ok: true; values: E[keyof E][] } | { ok: false; error: string } {
            const invalid = raw.filter((v) => !values.includes(v));
            if (invalid.length > 0) {
                return {
                    ok: false,
                    error: `Invalid ${field} value(s): ${invalid.join(', ')}. Expected one of: ${values.join(', ')}`,
                };
            }
            return { ok: true, values: raw as E[keyof E][] };
        },
    };
}

export const ticketStatusFilter = () => enumFilter(TicketStatus, 'status');
export const ticketSourceFilter = () => enumFilter(TicketSource, 'source');
export const ticketPriorityFilter = () => enumFilter(TicketPriority, 'priority');
export const ticketTypeFilter = () => enumFilter(TicketType, 'type');

export interface Pagination {
    page: number;
    pageSize: number;
    skip: number;
}

/** Parse page/pageSize defensively: NaN and out-of-range values fall back to defaults. */
export function parsePagination(searchParams: URLSearchParams): Pagination {
    const MAX_PAGE = 10000;
    const rawPage = Number.parseInt(searchParams.get('page') ?? '', 10);
    const rawPageSize = Number.parseInt(searchParams.get('pageSize') ?? '', 10);
    const page = Number.isSafeInteger(rawPage) && rawPage >= 1 && rawPage <= MAX_PAGE ? rawPage : 1;
    const pageSize = Number.isFinite(rawPageSize)
        ? Math.min(MAX_PAGE_SIZE, Math.max(1, rawPageSize))
        : DEFAULT_PAGE_SIZE;
    return { page, pageSize, skip: (page - 1) * pageSize };
}

/** Clamp free-text search input so a huge query string can't become a huge ILIKE. */
export function sanitizeSearch(raw: string | null): string | undefined {
    if (!raw) return undefined;
    const trimmed = raw.trim().slice(0, MAX_SEARCH_LENGTH);
    return trimmed ? trimmed : undefined;
}

export const ticketCreateSchema = z.object({
    title: nonEmptyTrimmed(MAX_TITLE_LENGTH),
    description: nonEmptyTrimmed(MAX_DESCRIPTION_LENGTH),
    priority: z.nativeEnum(TicketPriority).optional(),
    type: z.nativeEnum(TicketType).optional(),
    source: z.nativeEnum(TicketSource).optional(),
    sourceUrl: z.string().trim().max(MAX_URL_LENGTH).nullish(),
    additionalInfo: z.unknown().optional(),
    assigneeId: z.string().trim().max(MAX_ID_LENGTH).nullish(),
    accountId: z.string().trim().max(MAX_ID_LENGTH).nullish(),
    userId: z.string().trim().max(MAX_ID_LENGTH).nullish(),
});

export type TicketCreateInput = z.infer<typeof ticketCreateSchema>;

export const broadcastCreateSchema = z.object({
    message: nonEmptyTrimmed(MAX_BROADCAST_LENGTH),
    status: z.nativeEnum(BroadcastStatus).optional(),
    audience: z.nativeEnum(BroadcastAudience).optional(),
    targetAccounts: z.array(z.string().trim().max(MAX_ID_LENGTH)).max(500).nullish(),
    sendAs: z.string().trim().max(MAX_ID_LENGTH).nullish(),
});

export type BroadcastCreateInput = z.infer<typeof broadcastCreateSchema>;

export const articleCreateSchema = z.object({
    title: nonEmptyTrimmed(MAX_TITLE_LENGTH),
    content: nonEmptyTrimmed(MAX_CONTENT_LENGTH),
    categoryId: z.string().trim().min(1, 'must not be empty').max(MAX_ID_LENGTH),
    sourceUrl: z.string().trim().max(MAX_URL_LENGTH).nullish(),
});

export type ArticleCreateInput = z.infer<typeof articleCreateSchema>;

/** Flatten a ZodError into a single human-readable message. */
export function formatZodError(error: ZodError): string {
    const first = error.issues[0];
    if (!first) return 'Invalid request body';
    const path = first.path.join('.');
    return path ? `${path}: ${first.message}` : first.message;
}

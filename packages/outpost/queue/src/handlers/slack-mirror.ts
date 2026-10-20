/**
 * Slack ticket mirror job handler.
 *
 * Mirrors every ticket from GitHub and Discord into one internal Slack channel:
 * the ticket opens a thread, and community follow-ups plus the AI's reply post
 * as threaded replies underneath it. One Slack thread is the whole life of one
 * ticket.
 *
 * Read-only in v1 — replying inside Slack does not post back to the source.
 * Thread identity lives in TicketExternalLink (plugin `slack`, externalId
 * `channelId:ts`), reusing the same table the Linear and GitHub links use.
 */

import { WebClient } from '@slack/web-api';
import { prisma } from '@copilotkit/outpost/db';
import {
    readSlackMirrorConfig,
    isSlackMirrorEnabled,
    canSlackMirrorPost,
    buildPermalink,
    type SlackMirrorConfig,
} from '@copilotkit/outpost/shared/platforms';
import type {
    SlackMirrorPayload,
    SlackMirrorDelivery,
    JobResult,
    JobHandlerContext,
} from '../types.js';

/** TicketExternalLink.plugin value owned by the mirror. */
export const SLACK_MIRROR_PLUGIN = 'slack';

/**
 * Body budget per mirror post.
 *
 * NOT a Slack hard limit — `chat.postMessage` accepts 40,000 characters of
 * `text`. This is a readability cap for an internal feed, with headroom for the
 * header, origin line, and delivery note appended after truncation.
 */
const MAX_MIRROR_TEXT = 2800;

/** Minimal Slack surface the handler needs — lets tests inject a fake. */
export interface SlackPoster {
    postMessage(args: {
        channel: string;
        text: string;
        thread_ts?: string;
    }): Promise<{ ts?: string }>;
}

export interface SlackMirrorDeps {
    prisma: typeof prisma;
    config: SlackMirrorConfig;
    /** Omit to build a real WebClient from the config token. */
    poster?: SlackPoster;
}

function truncate(value: string, max: number): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max - 1)}…`;
}

/**
 * Escape the three characters Slack treats as markup control characters.
 *
 * Ticket bodies and replies are attacker-influenced text from a public issue
 * tracker or Discord. Interpolating them raw let a reporter inject links and
 * mrkdwn into an internal channel.
 * https://api.slack.com/reference/surfaces/formatting#escaping
 */
function escapeMrkdwn(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildPoster(config: SlackMirrorConfig): SlackPoster {
    if (!config.token) {
        throw new Error(
            'SLACK_BOT_TOKEN is required to post the ticket mirror. It must be set on the ' +
                'worker service (the mirror runs there, not in the Slack bot) and carry chat:write.',
        );
    }
    // Cap the client's internal retry sleeps: WebClient's default policy can
    // sleep for minutes, which would outlive the job timeout and leave a post
    // in flight after the worker gave up on it.
    const client = new WebClient(config.token, {
        retryConfig: { retries: 2, minTimeout: 200, maxTimeout: 2_000 },
    });
    return {
        async postMessage(args) {
            const result = await client.chat.postMessage(args);
            return { ts: result.ts as string | undefined };
        },
    };
}

/**
 * Slack errors that no retry can fix.
 *
 * `not_in_channel` needs a human to invite the bot; `channel_not_found` and
 * `invalid_auth` need a config change. Retrying them five times and
 * dead-lettering hides an operator task behind a fault that reads as transient,
 * so each is reported once with the remedy attached.
 */
const PERMANENT_SLACK_ERRORS: Record<string, string> = {
    not_in_channel:
        'invite the mirror bot to SLACK_MIRROR_CHANNEL_ID (Slack: channel → Integrations → Add apps)',
    channel_not_found:
        'SLACK_MIRROR_CHANNEL_ID does not name a channel this bot can see — check the ID, not the name',
    channel_is_archived:
        'the mirror channel is archived — point SLACK_MIRROR_CHANNEL_ID at a live channel',
    invalid_auth: 'SLACK_BOT_TOKEN is invalid or revoked — reissue it',
    account_inactive: 'the Slack bot account is deactivated — reinstall the app',
    missing_scope: 'the bot token lacks chat:write — add the scope and reinstall',
    token_expired: 'SLACK_BOT_TOKEN has expired — reissue it',
    token_revoked: 'SLACK_BOT_TOKEN was revoked — reissue it',
    not_authed: 'no token was sent — check SLACK_BOT_TOKEN on the worker',
    msg_too_long: 'the mirror post exceeded Slack limits — lower MAX_MIRROR_TEXT',
    is_archived: 'the mirror channel is archived — point SLACK_MIRROR_CHANNEL_ID at a live channel',
};

/**
 * Map a thrown Slack error to a permanent-failure result, or null when it looks
 * transient (rate limits, 5xx, network) and a retry is worth having.
 */
function classifySlackError(err: unknown, ticketLabel: string): JobResult | null {
    // @slack/web-api puts the API's error string on `err.data.error`, and often
    // on `err.message` too. Duck-type both rather than importing its error class.
    const data = (err as { data?: { error?: unknown } })?.data;
    const fromData = typeof data?.error === 'string' ? data.error : undefined;
    const message = err instanceof Error ? err.message : String(err);
    // Prefer the API's own error code. The message-substring scan is a fallback
    // for transports that only surface a string, and is order-independent because
    // it requires a whole-word match rather than any containment.
    const code =
        fromData ??
        Object.keys(PERMANENT_SLACK_ERRORS).find((k) => new RegExp(`\\b${k}\\b`).test(message));

    if (!code) return null;
    const remedy = Object.prototype.hasOwnProperty.call(PERMANENT_SLACK_ERRORS, code)
        ? PERMANENT_SLACK_ERRORS[code]
        : undefined;
    if (!remedy) return null;

    return {
        success: false,
        error: `Slack rejected the mirror post for ${ticketLabel}: ${code}. To fix: ${remedy}`,
        retryable: false,
    };
}

/** Thread-opening post: what the ticket is, who reported it, where it came from. */
function formatTicketPost(ticket: {
    displayId: string;
    title: string;
    source: string;
    sourceUrl: string | null;
    description: string | null;
}): string {
    const header = `*[${ticket.displayId}] ${escapeMrkdwn(truncate(ticket.title, 200))}*`;
    const origin = ticket.sourceUrl
        ? `${ticket.source} · <${ticket.sourceUrl}|view original>`
        : String(ticket.source);
    const body = ticket.description
        ? escapeMrkdwn(truncate(ticket.description, MAX_MIRROR_TEXT))
        : '_no body_';
    return `${header}\n${origin}\n\n${body}`;
}

/**
 * What each delivery outcome says to an internal reader.
 *
 * The mirror states the reason the producer recorded and nothing more. It used
 * to print "withheld or shadow mode" for every undelivered case, which named a
 * cause for failures that had a different one — the same misreporting #148
 * describes between what the DB holds and what was published.
 */
const DELIVERY_NOTES: Record<SlackMirrorDelivery, string> = {
    delivered: '',
    shadow: '\n_⚠️ not sent — SHADOW_MODE was on, so this was logged only_',
    withheld:
        '\n_⚠️ not sent — the groundedness gate withheld this draft; the reporter got the safe replacement_',
    'post-failed': '\n_⚠️ not sent — posting to the source platform failed_',
    'no-adapter': '\n_⚠️ not sent — no delivery was attempted for this source_',
};

/** An AI reply whose fate the payload did not record. Unknown is not "fine". */
const DELIVERY_UNKNOWN = '\n_⚠️ delivery unconfirmed — this reply carried no delivery status_';

/**
 * Threaded reply post.
 *
 * Community and team replies carry no delivery status: the platform delivered
 * them by definition. For an AI reply the status is mandatory in practice — its
 * absence renders as unconfirmed, never as delivered.
 */
function formatReplyPost(
    message: { author: string; content: string; isAiGenerated: boolean },
    delivery: SlackMirrorDelivery | undefined,
): string {
    const who = message.isAiGenerated ? `🤖 ${message.author}` : message.author;
    let note = '';
    if (message.isAiGenerated) {
        // A delivery value we do not recognize — an older queued payload, or
        // drift after this union changes — must fall back to "unconfirmed".
        // Indexing blindly rendered the literal string "undefined" into Slack.
        note =
            delivery && Object.prototype.hasOwnProperty.call(DELIVERY_NOTES, delivery)
                ? DELIVERY_NOTES[delivery]
                : DELIVERY_UNKNOWN;
    }
    return `*${escapeMrkdwn(who)}*${note}\n${escapeMrkdwn(truncate(message.content, MAX_MIRROR_TEXT))}`;
}

/**
 * Handle a SLACK_MIRROR job.
 *
 * Ordering note: a `reply` whose thread does not exist yet opens the thread
 * first. Jobs can land out of order, and the mirror can be switched on partway
 * through a live conversation; neither should drop messages on the floor.
 *
 * Idempotency covers THREAD identity only: the TicketExternalLink row — not the
 * config — is the identity of the thread. It does NOT dedupe reply posts; a
 * duplicate reply job re-posts its message (it just cannot open a rival thread).
 * Message-level dedup needs a per-message marker and is tracked separately.
 *
 * Thread identity: the TicketExternalLink row — not the config — is the identity
 * of the thread. Two jobs for one ticket can both read "no link" and both post a
 * root message; the one that loses `@@unique([ticketId, plugin])` re-reads the
 * row and threads under the winner's ts rather than opening a rival thread. A
 * row whose externalId cannot be parsed is repaired in place, never duplicated.
 */
export async function handleSlackMirror(
    payload: SlackMirrorPayload,
    context: JobHandlerContext,
    deps?: Partial<SlackMirrorDeps>,
): Promise<JobResult> {
    const db = deps?.prisma ?? prisma;
    const config = deps?.config ?? readSlackMirrorConfig();

    if (!isSlackMirrorEnabled(config)) {
        return { success: true, data: { skipped: 'mirror-disabled' } };
    }

    // Enabled but unable to post: `live` with no token. Reported as a permanent
    // failure naming the variable rather than completing silently — the producers
    // deliberately do NOT gate on the token (they never post), so silence here
    // would leave the team's channel quietly empty with no signal anywhere.
    if (!canSlackMirrorPost(config)) {
        return {
            success: false,
            error:
                'SLACK_MIRROR_MODE=live but SLACK_BOT_TOKEN is unset on this service — set it ' +
                '(needs chat:write) on outpost-worker, where the mirror handler posts from',
            retryable: false,
        };
    }
    // isSlackMirrorEnabled guarantees this, but the compiler does not know it.
    const channelId = config.channelId!;

    await context.reportProgress(10);

    const ticket = await db.ticket.findUnique({ where: { id: payload.ticketId } });
    if (!ticket) {
        // Deliberately RETRYABLE, unlike the payload checks below. The producers
        // enqueue this job right after creating the ticket but not in the same
        // transaction, so a worker that claims the job first can legitimately
        // miss the row. A retry resolves that; a permanent failure would lose a
        // real ticket's thread.
        return { success: false, error: `Ticket ${payload.ticketId} not found` };
    }

    const linkWhere = {
        ticketId_plugin: { ticketId: ticket.id, plugin: SLACK_MIRROR_PLUGIN },
    };
    const existingLink = await db.ticketExternalLink.findUnique({ where: linkWhere });
    let thread = existingLink ? parseThreadRef(existingLink.externalId) : null;

    // Already mirrored — opening a second thread for the same ticket would
    // split its history across two places. A link we cannot parse does NOT
    // count as mirrored: it falls through to the repair path below.
    if (payload.kind === 'ticket' && thread) {
        return { success: true, data: { skipped: 'already-mirrored' } };
    }

    // ── Validate the job before anything is posted ───────────────────────────
    if (payload.kind !== 'ticket' && payload.kind !== 'reply') {
        return {
            success: false,
            error: `SLACK_MIRROR job has unknown kind ${JSON.stringify(payload.kind)}`,
            retryable: false,
        };
    }

    // A reply job used to reach the thread-opening post first and only then
    // discover it had no messageId — posting a root message to Slack on every
    // one of its retries. Validation owes no side effects.
    let replyMessage: {
        id: string;
        author: string;
        content: string;
        isAiGenerated: boolean;
    } | null = null;
    if (payload.kind === 'reply') {
        if (!payload.messageId) {
            return {
                success: false,
                error: 'SLACK_MIRROR reply job is missing required field `messageId`',
                retryable: false,
            };
        }
        replyMessage = await db.message.findUnique({ where: { id: payload.messageId } });
        if (!replyMessage) {
            return {
                success: false,
                error: `SLACK_MIRROR reply job references Message ${payload.messageId}, which does not exist`,
                retryable: false,
            };
        }
    }

    const isShadow = config.mode === 'shadow';
    const poster = isShadow ? null : (deps?.poster ?? buildPoster(config));

    await context.reportProgress(40);

    // ── Open the thread when it does not exist yet ───────────────────────────
    if (!thread) {
        const text = formatTicketPost(ticket);
        if (isShadow) {
            console.log(
                `[Slack Mirror] shadow — would open thread in ${channelId} for ${ticket.displayId} ` +
                    '(shadow does not persist thread identity, so each shadow job logs an open; ' +
                    `a live run would open once):\n${text}`,
            );
        } else {
            let result: { ts?: string };
            try {
                result = await poster!.postMessage({ channel: channelId, text });
            } catch (err) {
                const permanent = classifySlackError(err, ticket.displayId);
                if (permanent) return permanent;
                throw err;
            }
            if (!result.ts) {
                // The post landed but we cannot address the thread it created.
                // NOT retryable: every retry would post another root message,
                // and there is no ts to recover from. Needs a human to look.
                return {
                    success: false,
                    error:
                        `Slack accepted the mirror post for ${ticket.displayId} but returned no ts — ` +
                        'the message was posted and its thread cannot be tracked; not retrying to avoid duplicates',
                    retryable: false,
                };
            }
            const opened = { channelId, ts: result.ts };
            const linkData = {
                externalId: `${opened.channelId}:${opened.ts}`,
                externalUrl: buildPermalink(opened.channelId, opened.ts),
            };

            if (existingLink) {
                // The row exists but its externalId is unusable. Repair it so the
                // thread we just opened becomes the ticket's identity — a second
                // create would fail the unique constraint on every attempt.
                await db.ticketExternalLink.update({ where: linkWhere, data: linkData });
                thread = opened;
            } else {
                try {
                    await db.ticketExternalLink.create({
                        data: {
                            ticketId: ticket.id,
                            plugin: SLACK_MIRROR_PLUGIN,
                            ...linkData,
                        },
                    });
                    thread = opened;
                } catch (err) {
                    if (!isUniqueViolation(err)) throw err;
                    // Another job for this ticket claimed the link first. Adopt its
                    // thread; our root post is an orphan, but every message from
                    // here on lands in the one thread the row points at.
                    const winner = await db.ticketExternalLink.findUnique({ where: linkWhere });
                    const winnerThread = winner ? parseThreadRef(winner.externalId) : null;
                    if (winnerThread) {
                        thread = winnerThread;
                    } else if (!winner) {
                        // The row that beat us is already gone. Updating it would
                        // throw P2025; retry instead, and the next attempt takes
                        // the clean create path.
                        return {
                            success: false,
                            error: `Slack mirror link for ${ticket.displayId} vanished mid-claim; retrying`,
                        };
                    } else {
                        // The winning row is itself unparseable — repair it rather
                        // than retry a create that can only fail again.
                        await db.ticketExternalLink.update({ where: linkWhere, data: linkData });
                        thread = opened;
                    }
                }
            }
        }
    }

    await context.reportProgress(70);

    // ── Post the reply underneath it ─────────────────────────────────────────
    if (payload.kind === 'reply') {
        const message = replyMessage!;
        const text = formatReplyPost(message, payload.delivery);
        if (isShadow) {
            console.log(
                `[Slack Mirror] shadow — would reply in ${thread?.channelId ?? channelId} on ${ticket.displayId}:\n${text}`,
            );
        } else {
            // Post into the channel the link records, not the currently configured
            // one: re-pointing SLACK_MIRROR_CHANNEL_ID must not orphan the replies
            // of tickets whose thread already lives somewhere else.
            try {
                await poster!.postMessage({
                    channel: thread!.channelId,
                    text,
                    thread_ts: thread!.ts,
                });
            } catch (err) {
                const permanent = classifySlackError(err, ticket.displayId);
                if (permanent) return permanent;
                throw err;
            }
        }
    }

    await context.reportProgress(100);

    return {
        success: true,
        data: { mode: config.mode, kind: payload.kind, ticketId: ticket.id },
    };
}

/** The Slack thread a ticket is mirrored into, as recorded on its link row. */
interface SlackThreadRef {
    channelId: string;
    ts: string;
}

/**
 * externalId is stored as `channelId:ts`. Both halves are load-bearing — the
 * channel is where replies go — so a row missing either half is unusable and
 * must be repaired, not read.
 */
function parseThreadRef(externalId: string): SlackThreadRef | null {
    const idx = externalId.indexOf(':');
    if (idx === -1) return null;
    const channelId = externalId.slice(0, idx);
    const ts = externalId.slice(idx + 1);
    if (!channelId || !ts) return null;
    return { channelId, ts };
}

/**
 * Prisma's unique-constraint failure. Duck-typed on purpose: importing the
 * Prisma runtime into a queue handler just to name an error class would drag
 * the client into every consumer's bundle.
 */
function isUniqueViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

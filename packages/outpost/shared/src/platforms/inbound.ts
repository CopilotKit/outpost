/**
 * InboundHandler — the shared code path all bots call after normalizing
 * a raw platform event into an InboundMessage.
 *
 * Handles:
 * 1. New tickets (isThreadStart=true): create Ticket + first Message, and enqueue
 *    AI_RESPONSE unless the sender is a team member. This is the only path here
 *    that ever enqueues.
 * 2. Replies (isThreadStart=false): find existing ticket, create Message, reopen if
 *    needed. Never enqueues AI_RESPONSE, whoever sent the reply — Outpost answers
 *    once per ticket, on the opening message only, and a human owns the thread
 *    after that.
 * 3. Orphaned replies (isThreadStart=false with no matching ticket): create the
 *    Ticket + Message so the customer's words are never dropped, but do NOT
 *    enqueue AI_RESPONSE — we never saw the message that opened the conversation.
 *    Of the callers, only Teams actually reaches this branch; Discord, the GitHub
 *    App and Slack drop untracked replies before calling in. See handleReply.
 * 4. Team member detection via ExternalIdentity -> TeamMember lookup
 * 5. Sequential display ID generation (TKT-XXXXXXXX)
 */

import type { InboundMessage, InboundResult, TicketRef } from './types.js';
import { generateTicketId, truncate } from '../utils.js';
import { reopensOnCustomerReply } from '../constants.js';
import { TicketSource } from '../types.js';
import {
    readSlackMirrorConfig,
    isSlackMirrorEnabled,
    isMirrorableSource,
} from './slack-mirror-config.js';
import { buildTicketSourceId } from './source-id.js';

/**
 * Prisma client interface — the subset of PrismaClient we actually call.
 * Allows dependency injection for testing without importing the full client.
 */
export interface PrismaLike {
    ticket: {
        create: (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            args: any,
        ) => Promise<{
            id: string;
            displayId: string;
            status: string;
            sourceId: string | null;
            channel: string | null;
            source: string;
        }>;
        findFirst: (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            args: any,
        ) => Promise<{
            id: string;
            displayId: string;
            status: string;
            sourceId: string | null;
            channel: string | null;
            source: string;
        } | null>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: (args: any) => Promise<{ id: string; displayId: string; status: string }>;
    };
    message: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create: (args: any) => Promise<{ id: string }>;
    };
    user: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findFirst: (args: any) => Promise<{ id: string; email: string | null } | null>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create: (args: any) => Promise<{ id: string }>;
    };
    teamMember: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findUnique: (args: any) => Promise<{ id: string } | null>;
    };
    ticketExternalLink: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create: (args: any) => Promise<{ id: string }>;
    };
}

/**
 * Job creation function interface — matches createJob signature.
 */
export type CreateJobFn = (
    type: string,
    // Every bot's wrapper declares `source` as required, so it stays required
    // here — narrowing it would break assignability for all of them. The index
    // signature is what lets a job type add its own fields.
    payload: { ticketId: string; threadId?: string; source: string; [key: string]: unknown },
) => Promise<string>;

/**
 * Detect a Prisma unique-constraint violation (P2002) without importing the
 * Prisma runtime here — inbound.ts stays decoupled behind PrismaLike, so we
 * duck-type the error code.
 */
function isUniqueConstraintError(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: unknown }).code === 'P2002'
    );
}

/**
 * Map TicketSource to PlatformTarget for job payloads.
 */
function toPlatformTarget(source: TicketSource): string {
    switch (source) {
        case TicketSource.DISCORD:
            return 'discord';
        case TicketSource.GITHUB_ISSUE:
            return 'github';
        case TicketSource.GITHUB_DISCUSSION:
            return 'github';
        case TicketSource.SLACK:
            return 'slack';
        case TicketSource.TEAMS:
            return 'teams';
        case TicketSource.EMAIL:
            return 'web';
        default:
            return 'web';
    }
}

/**
 * Configuration for the InboundHandler.
 */
export interface InboundHandlerConfig {
    /** Prisma client (or mock) for database operations */
    prisma: PrismaLike;
    /** Job creation function for enqueueing AI_RESPONSE jobs */
    createJob: CreateJobFn;
    /** Job type string for AI_RESPONSE (default: 'AI_RESPONSE') */
    aiResponseJobType?: string;
    /** Job type string for the Slack ticket mirror (default: 'SLACK_MIRROR') */
    slackMirrorJobType?: string;
    /**
     * Whether to enqueue Slack mirror jobs.
     *
     * Defaults to the environment's mirror configuration, so a deployment with
     * `SLACK_MIRROR_MODE=off` (or no channel configured) never queues work that
     * the handler would only discard. Tests pass this explicitly.
     */
    mirrorToSlack?: boolean;
}

/**
 * Per-call options for `InboundHandler.handle`.
 */
export interface HandleOptions {
    /**
     * Platform-specific metadata to store on `ticket.additionalInfo` when a new
     * ticket is created for a genuine thread start.
     *
     * It is passed in rather than written by the caller after `handle` returns
     * because the AI_RESPONSE enqueue happens inside `handle`: once that job row
     * exists the worker may claim it immediately, so anything the worker reads
     * off the ticket has to be committed with the ticket itself. Teams' Bot
     * Framework `conversationReference` is the live case — a worker that reads
     * the ticket before the reference lands falls back to a hardcoded global
     * `serviceUrl` and delivery fails for tenants in other regions.
     *
     * Ignored on replies, including the orphaned-reply fallback that files a
     * ticket for a conversation Outpost was never part of.
     */
    ticketAdditionalInfo?: Record<string, unknown>;
}

/**
 * The InboundHandler processes normalized messages from any platform.
 *
 * Usage:
 * ```
 * const handler = new InboundHandler({ prisma, createJob });
 * const result = await handler.handle(inboundMessage);
 * ```
 */
export class InboundHandler {
    private readonly prisma: PrismaLike;
    private readonly createJob: CreateJobFn;
    private readonly aiResponseJobType: string;
    private readonly slackMirrorJobType: string;
    private readonly mirrorToSlack: boolean;

    constructor(config: InboundHandlerConfig) {
        this.prisma = config.prisma;
        this.createJob = config.createJob;
        this.aiResponseJobType = config.aiResponseJobType ?? 'AI_RESPONSE';
        this.slackMirrorJobType = config.slackMirrorJobType ?? 'SLACK_MIRROR';
        this.mirrorToSlack = config.mirrorToSlack ?? isSlackMirrorEnabled(readSlackMirrorConfig());
    }

    /**
     * Enqueue a Slack mirror job, swallowing any failure.
     *
     * The mirror is an internal convenience view. A queue hiccup while
     * mirroring must never take down ticket creation for a real reporter, so
     * this logs and moves on rather than propagating.
     */
    private async enqueueSlackMirror(
        ticketId: string,
        source: TicketSource,
        payload: { kind: 'ticket' | 'reply'; messageId?: string },
    ): Promise<void> {
        if (!this.mirrorToSlack) return;

        // The mirror covers GitHub and Discord. `isMirrorableSource` is the ONE
        // place that rule lives; the AI-reply producer routes through the same
        // predicate, which is what stops the two producers from disagreeing
        // about whether a ticket is mirrorable. Slack-sourced tickets are
        // excluded because they already live in Slack.
        if (!isMirrorableSource(source)) return;

        try {
            await this.createJob(this.slackMirrorJobType, {
                ticketId,
                source: toPlatformTarget(source),
                ...payload,
            });
        } catch (err) {
            // The mirror is an internal convenience view; a queue failure here
            // must never take down ticket creation for a real reporter. Log the
            // error class and stack so schema drift is not mistaken for a
            // transient queue hiccup.
            console.error(
                `[InboundHandler] Failed to enqueue Slack mirror (${payload.kind}) for ticket ${ticketId}:`,
                err instanceof Error ? `${err.name}: ${err.message}` : String(err),
                err instanceof Error ? err.stack : undefined,
            );
        }
    }

    /**
     * Process an inbound message.
     *
     * Determines whether this is a new ticket or a reply to an existing one and
     * creates the appropriate database records. An AI_RESPONSE job is enqueued
     * only for a genuine thread start from a non-team-member — never for a
     * reply, and never for the orphaned-reply fallback below.
     */
    async handle(message: InboundMessage, options: HandleOptions = {}): Promise<InboundResult> {
        if (message.isThreadStart) {
            return this.handleNewTicket(message, {
                answer: true,
                orphanedReply: false,
                ticketAdditionalInfo: options.ticketAdditionalInfo,
            });
        }
        // Deliberately NOT forwarded to handleReply: its orphaned-reply fallback
        // creates a ticket for a conversation Outpost was never part of, and
        // platform metadata that claims the thread (Teams' conversationReference)
        // must not be attached to it. See the isOrphanedReply contract on
        // InboundResult.
        return this.handleReply(message);
    }

    /**
     * Create a new ticket from a thread-start message.
     *
     * `answer` is an explicit decision made by the caller, never inferred from
     * the message: `true` for a genuine thread start (the opening message is
     * the one message Outpost is allowed to answer), `false` for the orphaned-
     * reply fallback in `handleReply`, where we are creating a ticket around a
     * mid-conversation message we must not answer.
     *
     * `orphanedReply` is surfaced on the result as `isOrphanedReply` so callers
     * can distinguish "a real thread started" from "we filed a ticket around a
     * message in a conversation we were never part of". It is a separate
     * decision from `answer` on purpose — a caller must not have to infer one
     * from the other — even though today only the orphan path passes
     * `answer: false`.
     */
    private async handleNewTicket(
        message: InboundMessage,
        {
            answer,
            orphanedReply,
            ticketAdditionalInfo,
        }: {
            answer: boolean;
            orphanedReply: boolean;
            ticketAdditionalInfo?: Record<string, unknown>;
        },
    ): Promise<InboundResult> {
        const displayId = generateTicketId();
        const authorLabel = `${message.platformUsername} (${message.platformUserId})`;

        // Build sourceId through the SAME helper handleReply's lookup uses, so
        // the stored key and the searched-for key cannot drift apart. null here
        // means "this thread is not addressable" (no threadId, or Slack with no
        // channelId) — the ticket is still created so the report is not dropped,
        // but it will never be matched by a later reply.
        const sourceId = buildTicketSourceId(message.source, message.threadId, message.channelId);

        // Find-or-create the User row for the message sender so the ticket
        // can be linked to them (needed for reporter-identity lookups like
        // the GitHub reaction poll's ticket.user?.externalId check).
        const userId = await this.findOrCreateUser(
            message.platformUserId,
            message.platformUsername,
            message.source,
        );

        // Create the ticket
        const ticket = await this.prisma.ticket.create({
            data: {
                displayId,
                title: truncate(message.content, 200),
                description: truncate(message.content, 4000),
                status: 'OPEN',
                priority: 'MEDIUM',
                type: 'QUESTION',
                source: message.source,
                sourceId,
                sourceUrl: message.sourceUrl ?? null,
                channel: message.channelId ?? null,
                userId,
                // Platform-specific routing metadata the caller needs the worker
                // to see. Written HERE, in the same insert as the ticket, because
                // the AI_RESPONSE enqueue below makes the ticket claimable: a
                // caller that wrote it afterwards raced the worker, which then
                // fell back to a default (for Teams, a hardcoded global
                // serviceUrl) and failed delivery for tenants in other regions.
                ...(ticketAdditionalInfo ? { additionalInfo: ticketAdditionalInfo } : {}),
            },
        });

        // Create the first Message record
        let messageId: string | null = null;
        if (message.content) {
            const msg = await this.prisma.message.create({
                data: {
                    ticketId: ticket.id,
                    author: authorLabel,
                    content: truncate(message.content, 8000),
                    type: 'USER',
                    attachments: message.attachments
                        ? JSON.parse(JSON.stringify(message.attachments))
                        : undefined,
                },
            });
            messageId = msg.id;
        }

        // Team members still get a ticket but no AI answer. Only consulted when
        // the caller allowed an answer at all — otherwise the lookup is wasted.
        let aiJobEnqueued = false;
        if (answer && !(await this.isTeamMember(message.platformUserId, message.source))) {
            await this.createJob(this.aiResponseJobType, {
                ticketId: ticket.id,
                threadId: message.threadId,
                source: toPlatformTarget(message.source),
            });
            aiJobEnqueued = true;
        }

        // Mirror the new ticket into the internal Slack channel. The mirror's
        // thread-opening post carries the ticket body, so the first Message
        // does not also need a reply job.
        await this.enqueueSlackMirror(ticket.id, message.source, { kind: 'ticket' });

        return {
            ticketId: ticket.id,
            displayId,
            isNewTicket: true,
            isOrphanedReply: orphanedReply,
            aiJobEnqueued,
            messageId,
        };
    }

    /**
     * Handle a reply to an existing ticket thread.
     */
    private async handleReply(message: InboundMessage): Promise<InboundResult> {
        // Derive the lookup key with the same helper handleNewTicket stores
        // with. A null key means no ticket could ever carry it, so skip the
        // query entirely rather than searching for a synthesized placeholder.
        const sourceId = buildTicketSourceId(message.source, message.threadId, message.channelId);

        const ticket =
            sourceId === null ? null : await this.findTicketBySourceId(message.source, sourceId);

        if (!ticket) {
            // Orphaned reply: a mid-thread message whose thread we have no ticket
            // for — the thread predates Outpost, the platform delivered the reply
            // before the thread-start event, or the original ticket was deleted.
            //
            // We still create a ticket and persist the message: dropping a
            // customer's words is worse than filing an oddly-titled ticket, and a
            // human can pick it up from the dashboard.
            //
            // In practice only Teams reaches this branch. Every other caller
            // pre-filters an untracked reply and drops it before we are called:
            //   - Discord: apps/discord-bot/src/events/message-create.ts returns
            //     early when findTicketByThreadId finds nothing.
            //   - GitHub: apps/github-app/src/webhooks/issue-comment.ts returns
            //     early on no ticket, and never routes comments through this
            //     handler at all (its InboundHandler callers, issues-opened and
            //     discussion-created, are thread starts only).
            //   - Slack: apps/slack-bot/src/events/message.ts queries the ticket
            //     itself and returns when the reply's thread is untracked.
            // The web Postmark webhook does honour the principle, but implements
            // it locally (see apps/web/src/app/api/webhooks/postmark/route.ts,
            // isOrphanedReply) rather than through this path.
            //
            // So the preservation rationale above is the intent of this handler,
            // not the platform-wide behaviour of Outpost today. A reviewer flagged
            // the inconsistency; the resolution was to document it rather than
            // change three platforms' filtering. Anyone unifying this should
            // remove those pre-filters, not weaken this branch.
            //
            // We do NOT answer it. ASSUMPTION, stated so it is reviewable: the
            // message that opened the real conversation was never seen by us, so
            // this reply is not "the message that opened the ticket" in the
            // product sense even though it is the ticket's first message. Outpost
            // answers exactly one message per ticket — the opening one — and this
            // is not it.
            //
            // Refusing here is the only thing that stops it. The ticket we are
            // about to create carries no prior AI response, so the
            // already-answered gate in the AI_RESPONSE handler would wave it
            // straight through and answer a mid-thread "any update?" in a
            // conversation Outpost was never part of.
            // isOrphanedReply rides back out on the result: isNewTicket is
            // true here (a ticket really was created), so a caller that only
            // looks at isNewTicket would treat this like a fresh thread start
            // and, on Teams, post an acknowledgment card plus claim the
            // conversation for proactive messaging — bot chatter in a thread
            // we were never part of.
            return this.handleNewTicket(
                { ...message, isThreadStart: true },
                { answer: false, orphanedReply: true },
            );
        }

        const authorLabel = `${message.platformUsername} (${message.platformUserId})`;

        // Append the message
        const msg = await this.prisma.message.create({
            data: {
                ticketId: ticket.id,
                author: authorLabel,
                content: truncate(message.content, 8000),
                type: 'USER',
                attachments: message.attachments
                    ? JSON.parse(JSON.stringify(message.attachments))
                    : undefined,
            },
        });

        // NO AI RESPONSE ON REPLIES — deliberate, not an omission.
        //
        // Outpost answers the message that opens a ticket and nothing after it.
        // Replies only move ticket state; the thread belongs to a human from
        // the first response onward. Enqueuing here is what made the bot chime
        // in on follow-up questions between community members and summarise a
        // human's answer back at them.
        //
        // This refusal is what enforces the invariant. The already-answered
        // gate in the AI_RESPONSE handler
        // (packages/outpost/queue/src/handlers/ai-response.ts) is a backstop
        // against re-answering a ticket that already holds an AI response, not
        // a substitute: a reply on a ticket Outpost never answered — one opened
        // by a team member, say — would pass that gate untouched.
        const isTeam = await this.isTeamMember(message.platformUserId, message.source);

        if (isTeam) {
            // Team member replied: if ticket was WAITING_ON_TEAM, move to WAITING_ON_CUSTOMER
            if (ticket.status === 'WAITING_ON_TEAM') {
                await this.prisma.ticket.update({
                    where: { id: ticket.id },
                    data: { status: 'WAITING_ON_CUSTOMER' },
                });
            }
        } else if (reopensOnCustomerReply(ticket.status)) {
            // Customer/external reply reopens a dormant ticket so a human sees it.
            await this.prisma.ticket.update({
                where: { id: ticket.id },
                data: { status: 'OPEN' },
            });
        }

        // Mirror the follow-up under the ticket's existing Slack thread. Team
        // replies mirror too — the thread is meant to be the whole life of the
        // ticket, and a team answer is the most useful part of it.
        await this.enqueueSlackMirror(ticket.id, message.source, {
            kind: 'reply',
            messageId: msg.id,
        });

        return {
            ticketId: ticket.id,
            displayId: ticket.displayId,
            isNewTicket: false,
            isOrphanedReply: false,
            aiJobEnqueued: false,
            messageId: msg.id,
        };
    }

    /**
     * Find an existing ticket by source platform + an already-built sourceId.
     *
     * Deliberately takes the finished key rather than (threadId, channelId):
     * key construction lives in buildTicketSourceId alone, so this method
     * cannot disagree with what handleNewTicket stored.
     */
    private async findTicketBySourceId(
        source: TicketSource,
        sourceId: string,
    ): Promise<TicketRef | null> {
        const ticket = await this.prisma.ticket.findFirst({
            where: {
                source: source as string,
                sourceId,
            },
        });

        if (!ticket) return null;

        return {
            id: ticket.id,
            displayId: ticket.displayId,
            status: ticket.status,
            sourceId: ticket.sourceId,
            channel: ticket.channel,
            source: ticket.source as TicketSource,
        };
    }

    /**
     * Find or create the User row for a platform sender, so the ticket
     * created from their message can be linked via `ticket.userId`.
     *
     * Reuses the exact same lookup pattern `isTeamMember` uses ({ externalId,
     * source }) so a real team-member User row created elsewhere (with a
     * real email) is found and reused, never duplicated. If no User exists
     * yet, creates one with a synthesized placeholder email — GitHub/Discord
     * webhook payloads don't reliably include a real email for the sender,
     * but `User.email` is a required unique column.
     */
    private async findOrCreateUser(
        platformUserId: string,
        platformUsername: string,
        source: TicketSource,
    ): Promise<string> {
        const userSource = source as string;

        const existing = await this.prisma.user.findFirst({
            where: {
                externalId: platformUserId,
                source: userSource,
            },
        });

        if (existing) return existing.id;

        const placeholderEmail = `${source.toLowerCase()}-${platformUserId}@reporters.outpost.internal`;

        try {
            const created = await this.prisma.user.create({
                data: {
                    name: platformUsername,
                    email: placeholderEmail,
                    externalId: platformUserId,
                    source: userSource,
                },
            });
            return created.id;
        } catch (err) {
            // Concurrent-create race: another inbound message from the same
            // sender created this User between our findFirst and create, and
            // hit the unique email constraint first. Re-read and reuse it
            // rather than throwing — dropping a customer's ticket is worse.
            if (isUniqueConstraintError(err)) {
                const raced = await this.prisma.user.findFirst({
                    where: { externalId: platformUserId, source: userSource },
                });
                if (raced) return raced.id;
            }
            throw err;
        }
    }

    /**
     * Determine if a platform user is a team member.
     *
     * Uses the ExternalIdentity -> TeamMember lookup pattern established
     * by the existing bot implementations:
     * 1. Find a User with matching externalId and source
     * 2. If found, look up a TeamMember with the same email
     *
     * This is a unified version of the per-bot isTeamMember functions.
     */
    private async isTeamMember(platformUserId: string, source: TicketSource): Promise<boolean> {
        // Map TicketSource to the source values used in the User table.
        // GitHub issues and discussions both store users with their respective sources.
        const userSource = source as string;

        const user = await this.prisma.user.findFirst({
            where: {
                externalId: platformUserId,
                source: userSource,
            },
        });

        if (!user?.email) return false;

        const member = await this.prisma.teamMember.findUnique({
            where: { email: user.email },
        });

        return member !== null;
    }
}

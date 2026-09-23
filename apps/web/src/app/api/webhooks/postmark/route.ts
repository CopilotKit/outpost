/**
 * Postmark inbound email webhook.
 *
 * Receives inbound emails from Postmark and creates/updates tickets.
 * Postmark sends a POST with JSON containing:
 * - From, To, Subject, TextBody, HtmlBody, StrippedTextReply
 * - MailboxHash (plus-addressing: ticket+TKT-1234 -> TKT-1234)
 * - Headers, Attachments, MessageID
 *
 * One answer per ticket: a genuinely NEW email opens a ticket and gets exactly
 * one AI response; a REPLY is appended to its existing ticket and gets none.
 * Replies are detected first by `MailboxHash` (an exact ticket reference) and
 * then by the RFC 5322 threading headers `In-Reply-To` / `References`, which is
 * the only signal available when the customer's mail client replies to a plain
 * From address and drops the plus-address.
 *
 * BOTH signals are attacker-supplied, so both paths resolve through the same
 * two gates: the ticket must be `source: 'EMAIL'`, and the sender must already
 * be a participant on it. `MailboxHash` is a token we mint, but minting it does
 * not make it a secret — `generateTicketId()` is short (8 characters) and the
 * Discord/Slack bots published "Ticket TKT-XXXXXXXX created" into public
 * threads, so display IDs are harvestable. Without the gates, anyone holding one
 * could append to (and reopen) any ticket on any channel.
 *
 * A mail can carry a `MailboxHash` *and* threading headers, so an unresolved
 * hash falls through to header matching rather than short-circuiting to the
 * orphan path.
 */
import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@copilotkit/outpost/db';
import {
    generateTicketId,
    MAX_JOB_ATTEMPTS,
    reopensOnCustomerReply,
} from '@copilotkit/outpost/shared';
import { JobType } from '@copilotkit/outpost/queue';
import {
    extractTicketId,
    extractEmail,
    extractName,
    extractReplyMessageIds,
    hasReplyHeaders,
    isTicketParticipant,
    resolveMessageBody,
} from './utils';
import type { PostmarkInboundPayload } from './utils';

/** Ticket fields the reply paths need. */
type ReplyTargetTicket = { id: string; displayId: string; status: string };

/**
 * Everything either reply path needs: the append target plus the participant
 * set it is authorized against.
 */
const REPLY_TARGET_SELECT = {
    id: true,
    displayId: true,
    status: true,
    user: { select: { email: true } },
    account: { select: { domain: true } },
    messages: { select: { author: true } },
} as const;

/**
 * Resolve a plus-addressed `MailboxHash` to the ticket it names.
 *
 * A display ID is not a secret. `generateTicketId()` draws 8 characters from a
 * 32-character alphabet, and the Discord/Slack bots posted
 * "Ticket TKT-XXXXXXXX created" into public threads — those threads still carry
 * the IDs. So naming a ticket is not evidence of belonging to it, and this path
 * gets exactly the gates the header path has:
 *
 *   1. `source: 'EMAIL'` — an inbound mail may only ever address a ticket that
 *      was itself opened by mail, never a Discord/Slack/Teams/GitHub ticket
 *      whose display ID leaked into a public thread;
 *   2. `isTicketParticipant` — the same participant definition the header path
 *      uses, deliberately shared so the two cannot drift into subtly different
 *      notions of "belongs to this ticket".
 *
 * Failing either gate returns null, which is treated as unresolved: the caller
 * then tries header matching and finally the orphaned-reply path, so a
 * legitimate sender writing from a second address never loses their mail.
 */
async function findTicketByMailboxHash(
    displayId: string,
    senderEmail: string,
): Promise<ReplyTargetTicket | null> {
    const ticket = await prisma.ticket.findUnique({
        where: { displayId, source: 'EMAIL' },
        select: REPLY_TARGET_SELECT,
    });
    if (!ticket) return null;
    return isTicketParticipant(senderEmail, ticket) ? ticket : null;
}

/**
 * Resolve a reply to the ticket that already holds its conversation.
 *
 * Two places carry inbound Message-IDs: `Ticket.sourceId` (the email that
 * OPENED the ticket) and `Message.attachments.postmarkMessageId` (every
 * appended message). A reply can name either, so both are checked. Outbound
 * Message-IDs are never persisted, which is why `References` (the full chain,
 * including the customer's own opening ID) matters as much as `In-Reply-To`.
 *
 * `In-Reply-To` / `References` are supplied by the sender, and a Message-ID is
 * *known* to everyone who was ever on the thread — including a CC. Naming a
 * valid ID is therefore not evidence of belonging to the ticket, so every
 * candidate must additionally pass `isTicketParticipant(senderEmail, …)`. A
 * candidate that resolves but fails that check is treated as unresolved, which
 * sends the mail down the orphaned-reply path: filed as its own ticket for a
 * human, never answered, never dropped.
 *
 * Candidates are scanned oldest-first rather than taking the single oldest row,
 * so a chain naming both someone else's ticket and the sender's own still lands
 * on the sender's own.
 */
async function findTicketByReplyMessageIds(
    messageIds: string[],
    senderEmail: string,
): Promise<ReplyTargetTicket | null> {
    if (messageIds.length === 0) return null;

    // The opening email of a thread — the oldest match wins so a thread always
    // resolves to its root ticket.
    const openingTickets = await prisma.ticket.findMany({
        where: { source: 'EMAIL', sourceId: { in: messageIds } },
        orderBy: { createdAt: 'asc' },
        select: REPLY_TARGET_SELECT,
    });
    const openingTicket = openingTickets.find((ticket) =>
        isTicketParticipant(senderEmail, ticket),
    );
    if (openingTicket) return openingTicket;

    // A message appended mid-thread.
    const appendedMessages = await prisma.message.findMany({
        where: {
            ticket: { source: 'EMAIL' },
            OR: messageIds.map((id) => ({
                attachments: { path: ['postmarkMessageId'], equals: id },
            })),
        },
        orderBy: { createdAt: 'asc' },
        select: { ticket: { select: REPLY_TARGET_SELECT } },
    });
    return (
        appendedMessages
            .map((message) => message?.ticket)
            .find((ticket) => ticket && isTicketParticipant(senderEmail, ticket)) ?? null
    );
}

function isUniqueConstraintError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'P2002'
    );
}

function ticketCreatedResponse(ticket: { displayId: string }) {
    return NextResponse.json({ status: 'ticket_created', ticketId: ticket.displayId });
}

/**
 * A redelivery of an already-appended reply. Deliberately 2xx: Postmark retries
 * every non-2xx, so answering 4xx/5xx here would keep the retry loop alive
 * forever against a delivery we have fully processed.
 */
function replyAlreadyAppendedResponse(ticket: ReplyTargetTicket) {
    return NextResponse.json({
        status: 'message_appended',
        ticketId: ticket.displayId,
        duplicate: true,
    });
}

/**
 * Record the inbound Message-ID on every message, not just ones with files.
 * It is the only handle a later reply has on a mid-thread message, so it is
 * persisted unconditionally.
 *
 * The same ID also goes into the `sourceMessageId` column, which is what dedup
 * and reply resolution should read: it is indexed and uniquely constrained,
 * where this jsonb key is neither. The key stays because `findTicketByReplyMessageIds`
 * still reads it for rows written before that column existed.
 */
function buildMessageAttachments(body: PostmarkInboundPayload) {
    return {
        postmarkMessageId: body.MessageID,
        ...(body.Attachments?.length
            ? {
                  files: body.Attachments.map((a) => ({
                      name: a.Name,
                      contentType: a.ContentType,
                      size: a.ContentLength,
                  })),
              }
            : {}),
    };
}

/**
 * Append a customer reply to the ticket that already owns the conversation.
 *
 * Shared by both reply paths (plus-address `MailboxHash` and RFC 5322 threading
 * headers) so they cannot drift: same message write, same reopen rule, and — in
 * both cases — no AI job. Outpost answers the opening email once and a human
 * owns the rest of the thread. Not enqueuing here is what enforces that; the
 * AI_RESPONSE handler's already-answered gate only backstops re-answering a
 * ticket that already holds an AI response.
 *
 * Idempotent per Postmark MessageID. Postmark retries every non-2xx delivery and
 * this route's catch returns 500, so the same reply can arrive more than once.
 * Both observable effects of an append have to survive that, not just the row:
 *
 *  - the message: `Message.sourceMessageId` carries the delivery ID, and
 *    `@@unique([ticketId, sourceMessageId])` makes a second write impossible.
 *    The pre-read short-circuits the common retry; the constraint (surfacing as
 *    P2002) is the authority when two deliveries race.
 *  - the reopen: it runs ONLY on the branch that actually inserted the message,
 *    so a redelivery cannot drag a ticket a human has since resolved back into
 *    the queue. Insert and reopen share one transaction, so the reverse gap —
 *    message committed, reopen lost, retry now a no-op and the reply never
 *    surfaced to a human — cannot happen either.
 */
async function appendReplyToTicket(
    ticket: ReplyTargetTicket,
    body: PostmarkInboundPayload,
    author: string,
    content: string,
) {
    const existingMessage = await prisma.message.findFirst({
        where: { ticketId: ticket.id, sourceMessageId: body.MessageID },
        select: { id: true },
    });
    if (existingMessage) return replyAlreadyAppendedResponse(ticket);

    try {
        await prisma.$transaction(async (tx) => {
            await tx.message.create({
                data: {
                    ticketId: ticket.id,
                    author,
                    content,
                    type: 'USER',
                    sourceMessageId: body.MessageID,
                    attachments: buildMessageAttachments(body),
                },
            });

            // Re-open a dormant ticket so a human sees the reply. The status set
            // lives in @copilotkit/outpost/shared so this path, the shared
            // InboundHandler, and the GitHub App issue-comment webhook cannot
            // drift apart.
            if (reopensOnCustomerReply(ticket.status)) {
                await tx.ticket.update({
                    where: { id: ticket.id },
                    data: { status: 'OPEN', updatedAt: new Date() },
                });
            }
        });
    } catch (error) {
        // Lost the race against a concurrent delivery of this same MessageID.
        // That delivery appended the message and applied the reopen, so this one
        // is complete by definition — and must not repeat either effect.
        if (isUniqueConstraintError(error)) return replyAlreadyAppendedResponse(ticket);
        throw error;
    }

    return NextResponse.json({ status: 'message_appended', ticketId: ticket.displayId });
}

export async function POST(request: Request) {
    // Webhook authentication via POSTMARK_WEBHOOK_TOKEN
    // Required in production; optional in development for local testing
    const webhookToken = process.env.POSTMARK_WEBHOOK_TOKEN;
    if (!webhookToken) {
        if (process.env.NODE_ENV === 'production') {
            return NextResponse.json(
                { error: 'Webhook authentication not configured' },
                { status: 500 },
            );
        }
        // Allow unauthenticated requests in non-production (local dev)
    } else {
        const authHeader = request.headers.get('authorization') ?? '';
        const expected = `Basic ${Buffer.from(webhookToken).toString('base64')}`;
        // Use timing-safe comparison to prevent timing attacks
        const authBuf = Buffer.from(authHeader);
        const expectedBuf = Buffer.from(expected);
        if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
    }

    let body: PostmarkInboundPayload;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    if (!body.From || !body.Subject || !body.MessageID) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const senderEmail = extractEmail(body.From);
    const senderName = extractName(body.From, body.FromName);
    // StrippedTextReply → TextBody → text derived from HtmlBody. HTML-only mail
    // (Outlook, most marketing-suite senders) has no TextBody at all, and used to
    // land as an empty ticket plus an AI job over an empty question.
    const { content: messageBody, hasText: hasUsableBody } = resolveMessageBody(body);
    const ticketIdFromHash = extractTicketId(body.MailboxHash);

    const author = `${senderName} <${senderEmail}>`;

    try {
        // MailboxHash is the primary reply path: it is an exact ticket reference
        // and cheaper than header matching.
        let replyTarget = ticketIdFromHash
            ? await findTicketByMailboxHash(ticketIdFromHash, senderEmail)
            : null;

        // Fallback: most mail clients reply to the plain From address and never
        // preserve the plus-address, so RFC 5322 threading headers are the only
        // thing marking those as replies.
        //
        // This runs whenever the hash did not resolve, not only when there was
        // no hash. A mail can legitimately carry both, and a hash that names a
        // deleted ticket — or one this sender is not a participant on, or one on
        // a non-email channel — must not cost the mail its shot at header
        // resolution. (No hash and no threading headers means no candidate IDs,
        // so this costs no query on the genuinely-new-email path.)
        if (!replyTarget) {
            replyTarget = await findTicketByReplyMessageIds(
                extractReplyMessageIds(body.Headers),
                senderEmail,
            );
        }

        if (replyTarget) {
            return await appendReplyToTicket(replyTarget, body, author, messageBody);
        }

        // A reply we could not resolve — a parsed MailboxHash or threading
        // headers that no ticket accepted: no such ticket (deleted, or a thread
        // that predates Outpost), a non-EMAIL ticket, or a sender who is not a
        // participant on the ticket named. Preserve the customer's words as a new
        // ticket/message for a human, but do not spend an AI response on a
        // mid-conversation message.
        const isOrphanedReply = ticketIdFromHash !== null || hasReplyHeaders(body.Headers);

        // Postmark retries the same inbound delivery with the same MessageID.
        // This read avoids deliberately colliding on the common retry path; the
        // partial unique index remains the concurrency authority when two first
        // deliveries pass this check together.
        const existingInboundTicket = await prisma.ticket.findFirst({
            where: { source: 'EMAIL', sourceId: body.MessageID },
            select: { id: true, displayId: true },
        });
        if (existingInboundTicket) {
            return ticketCreatedResponse(existingInboundTicket);
        }

        // Create the ticket (including its nested opening Message) and its one
        // AI_RESPONSE job in the same database transaction. A queue insert
        // failure rolls the ticket back, so Postmark can retry from a clean
        // state rather than creating a second ticket around a partial first run.
        const displayId = generateTicketId();
        let ticket: { id: string; displayId: string };
        try {
            ticket = await prisma.$transaction(async (tx) => {
                const createdTicket = await tx.ticket.create({
                    data: {
                        displayId,
                        title: body.Subject,
                        description: messageBody,
                        status: 'OPEN',
                        priority: 'MEDIUM',
                        type: 'QUESTION',
                        source: 'EMAIL',
                        sourceId: body.MessageID,
                        messages: {
                            create: {
                                author,
                                content: messageBody,
                                type: 'USER',
                                sourceMessageId: body.MessageID,
                                attachments: buildMessageAttachments(body),
                            },
                        },
                    },
                });

                // Only a genuinely new email gets the ticket's single AI response,
                // and only when there is actually a question to answer. With no
                // readable text the model has nothing to work from and emits its
                // apology fallback — which is then delivered to the customer and
                // marks the ticket answered. The ticket is still created so a
                // human keeps the subject and any attachments.
                if (!isOrphanedReply && hasUsableBody) {
                    await tx.job.create({
                        data: {
                            type: JobType.AI_RESPONSE,
                            payload: { ticketId: createdTicket.id, source: 'web' },
                            maxAttempts: MAX_JOB_ATTEMPTS,
                        },
                    });
                }

                return createdTicket;
            });
        } catch (error) {
            if (isUniqueConstraintError(error)) {
                const concurrentTicket = await prisma.ticket.findFirst({
                    where: { source: 'EMAIL', sourceId: body.MessageID },
                    select: { id: true, displayId: true },
                });
                if (concurrentTicket) return ticketCreatedResponse(concurrentTicket);
            }
            throw error;
        }

        return ticketCreatedResponse(ticket);
    } catch (err) {
        console.error('[Postmark Webhook] Error processing inbound email:', err);
        return NextResponse.json(
            { error: 'Internal error processing email' },
            { status: 500 },
        );
    }
}

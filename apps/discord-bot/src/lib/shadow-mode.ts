import { prisma } from '@copilotkit/outpost/db';
import { createJob, JobType } from '@copilotkit/outpost/queue';
import { TicketSource, buildTicketSourceId, truncate } from '@copilotkit/outpost/shared';
import type { ThreadChannel, Message } from 'discord.js';

/**
 * Shadow mode allows Outpost to run alongside Orca without double-posting.
 *
 * When SHADOW_MODE=true:
 *   - Tickets are created in the Outpost DB as normal
 *   - AI responses are generated but NOT posted to Discord
 *   - Shadow responses are logged for quality comparison against Orca
 *
 * This enables a parallel-run validation period before full cutover.
 */
// Re-exported rather than reimplemented. Three copies of this predicate existed
// and all three compared `=== 'true'`; a shared one is the only version of this
// that stays fixed.
export { isShadowMode } from '@copilotkit/outpost/shared';

export interface ShadowResponse {
    ticketId: string;
    threadId: string;
    generatedContent: string;
    generatedAt: Date;
    responseTimeMs: number;
}

/**
 * Log a shadow response for later quality comparison.
 * Stored as a SYSTEM-type message on the ticket with metadata in attachments.
 */
export async function logShadowResponse(response: ShadowResponse): Promise<void> {
    await prisma.message.create({
        data: {
            ticketId: response.ticketId,
            author: 'outpost-shadow',
            content: truncate(response.generatedContent, 8000),
            type: 'SYSTEM',
            isAiGenerated: true,
            attachments: {
                // shadowMode flag handled at the job handler level via env var
                threadId: response.threadId,
                responseTimeMs: response.responseTimeMs,
                generatedAt: response.generatedAt.toISOString(),
            },
        },
    });

    console.log(
        `[Shadow Mode] Logged response for ticket ${response.ticketId} ` +
            `(${response.responseTimeMs}ms)`,
    );
}

/**
 * In shadow mode, create the ticket but skip the Discord acknowledgment.
 * Returns the created ticket ID, or null if creation failed.
 */
export async function handleShadowThreadCreate(
    thread: ThreadChannel,
    displayId: string,
    content: string,
    authorTag: string,
    authorId: string,
): Promise<string | null> {
    try {
        // Build the lookup key through the SAME helper findTicketByThreadId
        // reads with, so the stored key and the searched-for key cannot drift
        // apart. null means "this thread is not addressable" (no thread ID) —
        // the ticket is still created so the report is not dropped, but no later
        // reply will match it.
        const sourceId = buildTicketSourceId(TicketSource.DISCORD, thread.id);

        const ticket = await prisma.ticket.create({
            data: {
                displayId,
                title: truncate(thread.name, 200),
                description: truncate(content, 4000),
                status: 'OPEN',
                priority: 'MEDIUM',
                type: 'QUESTION',
                source: 'DISCORD',
                sourceId,
                sourceUrl: thread.url,
                channel: thread.parentId ?? undefined,
            },
        });

        // Create the first message record if there's content
        if (content) {
            await prisma.message.create({
                data: {
                    ticketId: ticket.id,
                    author: `${authorTag} (${authorId})`,
                    content: truncate(content, 8000),
                    type: 'USER',
                },
            });
        }

        // Enqueue the one AI response this ticket gets. The handler reads
        // SHADOW_MODE itself and, when it is set, logs the generated response as
        // a SYSTEM message on the ticket instead of posting it to Discord (it
        // writes that row inline — it does not call logShadowResponse below).
        await createJob(JobType.AI_RESPONSE, {
            ticketId: ticket.id,
            threadId: thread.id,
            source: 'discord' as const,
            // shadowMode flag handled at the job handler level via env var
        });

        console.log(
            `[Shadow Mode] Created ticket ${displayId} for thread ${thread.id} (no Discord post)`,
        );

        return ticket.id;
    } catch (error) {
        console.error(`[Shadow Mode] Failed to create ticket for thread ${thread.id}:`, error);
        return null;
    }
}

/**
 * In shadow mode, record the message but don't trigger a visible AI response.
 */
export async function handleShadowMessage(
    message: Message,
    ticketId: string,
    threadId: string,
): Promise<void> {
    try {
        await prisma.message.create({
            data: {
                ticketId,
                author: `${message.author.tag} (${message.author.id})`,
                content: truncate(message.content, 8000),
                type: 'USER',
            },
        });

        // No AI response on a reply — shadow mode mirrors production behaviour,
        // and production answers a ticket once, on its opening message only.
        // Enqueuing here would make shadow traffic look chattier than the real
        // thing, which defeats the point of shadowing.

        console.log(
            `[Shadow Mode] Recorded message from ${message.author.tag} on ticket ${ticketId}`,
        );
    } catch (error) {
        console.error(
            `[Shadow Mode] Failed to record message from ${message.author.tag} on ticket ${ticketId}:`,
            error,
        );
    }
}

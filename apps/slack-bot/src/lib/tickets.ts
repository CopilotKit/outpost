import { prisma } from '@outpost/db';

/**
 * Find a ticket by its Slack thread timestamp and channel ID.
 * Tickets from Slack use a composite sourceId of "channelId:threadTs"
 * so we can distinguish threads across channels.
 */
export async function findTicketByThreadTs(channelId: string, threadTs: string) {
    return prisma.ticket.findFirst({
        where: {
            source: 'SLACK',
            sourceId: `${channelId}:${threadTs}`,
        },
    });
}

/**
 * Determine if a Slack user ID belongs to a team member.
 * Team members have their Slack ID stored as externalId on a User
 * that is linked to a TeamMember via email.
 */
export async function isTeamMember(slackUserId: string): Promise<boolean> {
    const user = await prisma.user.findFirst({
        where: {
            externalId: slackUserId,
            source: 'SLACK',
        },
    });

    if (!user?.email) return false;

    const member = await prisma.teamMember.findUnique({
        where: { email: user.email },
    });

    return member !== null;
}

/**
 * Build a Slack permalink URL for a thread message.
 */
export function buildPermalink(channelId: string, threadTs: string): string {
    // Slack permalinks use the format: /archives/CHANNEL_ID/pTIMESTAMP
    // The timestamp has dots removed
    const tsNoDot = threadTs.replace('.', '');
    return `https://slack.com/archives/${channelId}/p${tsNoDot}`;
}

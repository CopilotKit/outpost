import { NextResponse } from 'next/server';
import { MOCK_PENDING_MESSAGES } from '@/lib/mock-messages';
import { MessageStatus, MessageSource, checkUnansweredMessages } from '@outpost/shared';

/**
 * GET /api/messaging/stats
 *
 * Returns messaging statistics: total pending, overdue count, source breakdown.
 */
export async function GET() {
    const now = new Date();
    const unanswered = MOCK_PENDING_MESSAGES.filter(
        (m) => m.status === MessageStatus.UNANSWERED,
    );
    const overdue = checkUnansweredMessages(MOCK_PENDING_MESSAGES, now);
    const slackCount = MOCK_PENDING_MESSAGES.filter(
        (m) => m.source === MessageSource.SLACK,
    ).length;
    const teamsCount = MOCK_PENDING_MESSAGES.filter(
        (m) => m.source === MessageSource.TEAMS,
    ).length;

    // Average response time for answered messages
    const answered = MOCK_PENDING_MESSAGES.filter(
        (m) => m.status === MessageStatus.ANSWERED && m.answeredAt,
    );
    const avgResponseTimeMs =
        answered.length > 0
            ? answered.reduce((sum, m) => {
                  return sum + (new Date(m.answeredAt!).getTime() - new Date(m.receivedAt).getTime());
              }, 0) / answered.length
            : 0;

    return NextResponse.json({
        totalPending: unanswered.length,
        overdueCount: overdue.length,
        slackCount,
        teamsCount,
        avgResponseTimeMs,
    });
}

import { NextResponse } from 'next/server';
import { MOCK_PENDING_MESSAGES } from '@/lib/mock-messages';

/**
 * GET /api/messaging/pending
 *
 * Returns all pending customer messages across Slack Connect and MS Teams.
 */
export async function GET() {
    return NextResponse.json({
        messages: MOCK_PENDING_MESSAGES,
        count: MOCK_PENDING_MESSAGES.length,
    });
}

import type { WebClient } from '@slack/web-api';

export interface PostResponseOptions {
    client: WebClient;
    channelId: string;
    threadTs: string;
    text: string;
    ticketDisplayId: string;
    confidence?: number;
}

/**
 * Posts an AI-generated response as a threaded reply in Slack.
 * Uses Slack's mrkdwn format and adds action buttons for user feedback.
 */
export async function postAiResponse(options: PostResponseOptions): Promise<void> {
    const { client, channelId, threadTs, text, ticketDisplayId, confidence } = options;

    // Block Kit blocks for the message. Using inline type to avoid
    // importing @slack/types as a direct dependency.
    const blocks: Array<{
        type: string;
        [key: string]: unknown;
    }> = [];

    // Add confidence disclaimer for low-confidence responses
    if (confidence !== undefined && confidence < 0.7) {
        blocks.push({
            type: 'context',
            elements: [
                {
                    type: 'mrkdwn',
                    text: ':warning: _This response has lower confidence. A team member may follow up._',
                },
            ],
        });
    }

    // Main response text
    blocks.push({
        type: 'section',
        text: {
            type: 'mrkdwn',
            text,
        },
    });

    // Action buttons
    blocks.push({
        type: 'actions',
        block_id: `ticket_actions_${ticketDisplayId}`,
        elements: [
            {
                type: 'button',
                text: {
                    type: 'plain_text',
                    text: 'Issue Solved',
                    emoji: true,
                },
                style: 'primary',
                action_id: 'issue_solved',
                value: ticketDisplayId,
            },
            {
                type: 'button',
                text: {
                    type: 'plain_text',
                    text: 'Need more help',
                    emoji: true,
                },
                style: 'danger',
                action_id: 'need_more_help',
                value: ticketDisplayId,
            },
        ],
    });

    await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text, // Fallback for notifications
        blocks,
    });
}

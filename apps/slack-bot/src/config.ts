/**
 * Slack bot configuration from environment variables.
 */
export const config = {
    slackBotToken: requireEnv('SLACK_BOT_TOKEN'),
    slackAppToken: requireEnv('SLACK_APP_TOKEN'),
    slackSigningSecret: requireEnv('SLACK_SIGNING_SECRET'),
    monitoredChannelIds: parseCommaSeparated(process.env.MONITORED_CHANNEL_IDS ?? ''),
    /** Team member Slack user IDs (comma-separated). Users in this list won't trigger AI responses. */
    teamMemberIds: parseCommaSeparated(process.env.TEAM_MEMBER_IDS ?? ''),
} as const;

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function parseCommaSeparated(value: string): string[] {
    return value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

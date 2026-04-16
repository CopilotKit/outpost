import { App, LogLevel } from '@slack/bolt';
import { config } from './config.js';
import { registerMessageHandler } from './events/message.js';
import { registerActionHandlers } from './events/actions.js';
import { registerCommands } from './commands/index.js';
import { startHealthServer } from './health.js';

const healthPort = parseInt(process.env.HEALTH_PORT ?? '3002', 10);
const healthServer = startHealthServer(healthPort);

const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    signingSecret: config.slackSigningSecret,
    socketMode: process.env.SLACK_SOCKET_MODE !== 'false',
    logLevel: process.env.NODE_ENV === 'production' ? LogLevel.INFO : LogLevel.DEBUG,
});

// Register all event handlers
registerMessageHandler(app);
registerActionHandlers(app);
registerCommands(app);

// Start the bot
(async () => {
    const port = parseInt(process.env.PORT ?? '3000', 10);
    await app.start(port);
    console.log(`[Slack Bot] Running (socket mode: ${process.env.SLACK_SOCKET_MODE !== 'false'})`);
})().catch((error) => {
    console.error('[Slack Bot] Failed to start:', error);
    process.exit(1);
});

// Graceful shutdown
const shutdown = async () => {
    console.log('[Slack Bot] Shutting down...');
    healthServer.close();
    await app.stop();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

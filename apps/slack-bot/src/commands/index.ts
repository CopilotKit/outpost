import type { App } from '@slack/bolt';
import { registerAssignCommand } from './assign.js';
import { registerCloseCommand } from './close.js';
import { registerEscalateCommand } from './escalate.js';
import { registerPriorityCommand } from './priority.js';

/**
 * Register all slash commands with the Slack Bolt app.
 */
export function registerCommands(app: App): void {
    registerAssignCommand(app);
    registerCloseCommand(app);
    registerEscalateCommand(app);
    registerPriorityCommand(app);
}

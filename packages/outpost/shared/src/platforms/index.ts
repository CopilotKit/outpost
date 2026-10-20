/**
 * Platform Adapters — the single abstraction for all platform I/O in Outpost.
 *
 * This module exports:
 * - Types: PlatformAdapter, InboundMessage, PlatformUser, etc.
 * - Registry: getAdapter, hasAdapter, clearAdapterCache
 * - InboundHandler: shared ticket creation/reply flow
 * - Individual adapters for each platform
 *
 * NOTE: Individual adapter classes are exported with "Platform" prefix to avoid
 * name collisions with the sync adapter classes (e.g. sync/GitHubAdapter).
 * Import from this module directly if you need the unprefixed names:
 *   import { GitHubAdapter } from '@copilotkit/outpost/shared/platforms/github'
 */

// Types
export type {
    PlatformAdapter,
    InboundMessage,
    PlatformUser,
    Attachment,
    FormattedResponse,
    TicketRef,
    InboundResult,
} from './types.js';

// Registry
export { getAdapter, hasAdapter, clearAdapterCache, SUPPORTED_PLATFORMS } from './registry.js';

// Ticket sourceId key builder — the single definition shared by ticket
// creation, reply lookup, and the bots' own "is this thread tracked?" checks.
export { buildTicketSourceId } from './source-id.js';

// Inbound handler
export { InboundHandler } from './inbound.js';
export type { InboundHandlerConfig, CreateJobFn, HandleOptions } from './inbound.js';
export type { PrismaLike as InboundPrismaLike } from './inbound.js';

// Individual adapters — re-exported with "Platform" prefix to avoid
// collision with sync adapter names (GitHubAdapter, GitHubAdapterConfig).
export { DiscordAdapter as PlatformDiscordAdapter } from './discord.js';
export type { DiscordAdapterConfig as PlatformDiscordAdapterConfig } from './discord.js';

// GitHub adapter — use PlatformGitHubAdapter / GitHubPlatformAdapter to avoid
// collision with the sync module's GitHubAdapter.
export { GitHubAdapter as PlatformGitHubAdapter, GitHubPlatformAdapter } from './github.js';
export type {
    GitHubAdapterConfig as PlatformGitHubAdapterConfig,
    GitHubOctokitLike,
} from './github.js';

export { SlackAdapter as PlatformSlackAdapter, SlackAdapter, buildPermalink } from './slack.js';

// Slack ticket mirror — flag semantics shared by the producers (inbound
// handler, AI response handler) and the consumer (SLACK_MIRROR job handler).
export {
    readSlackMirrorConfig,
    isSlackMirrorEnabled,
    canSlackMirrorPost,
    isMirrorableSource,
} from './slack-mirror-config.js';
export type { SlackMirrorConfig, SlackMirrorMode } from './slack-mirror-config.js';
export type {
    SlackAdapterConfig as PlatformSlackAdapterConfig,
    SlackAdapterConfig,
    SlackMessageEvent,
} from './slack.js';

export { TeamsAdapter as PlatformTeamsAdapter, TeamsAdapter } from './teams.js';
export type {
    TeamsAdapterConfig as PlatformTeamsAdapterConfig,
    TeamsAdapterConfig,
    TeamsActivity,
    TeamsConversationReference,
} from './teams.js';

export { EmailPostmarkAdapter as PlatformEmailPostmarkAdapter } from './email-postmark.js';
export type { EmailPostmarkAdapterConfig as PlatformEmailPostmarkAdapterConfig } from './email-postmark.js';

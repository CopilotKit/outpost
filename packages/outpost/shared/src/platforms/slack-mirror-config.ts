/**
 * Configuration for the Slack ticket mirror.
 *
 * The mirror posts every ticket from GitHub and Discord into one internal Slack
 * channel, with follow-ups threaded underneath, so a single Slack thread is the
 * whole life of one ticket.
 *
 * `SLACK_MIRROR_MODE` is deliberately INDEPENDENT of `SHADOW_MODE`. That flag
 * protects community surfaces (Discord, GitHub) where real reporters are
 * watching; the mirror targets an internal team channel, so posting there from
 * staging is intended rather than a violation of the standing shadow-mode rule.
 * The mirror's own three-way flag is what keeps it inert until it is configured.
 */

/** `off` no-ops · `shadow` logs what it would post · `live` posts to Slack. */
export type SlackMirrorMode = 'off' | 'shadow' | 'live';

export interface SlackMirrorConfig {
    mode: SlackMirrorMode;
    /** Slack channel ID (e.g. C09AB2CD3EF) — an ID, never a channel name. */
    channelId: string | null;
    /** Bot token; must carry chat:write. Required by the worker, which posts. */
    token: string | null;
}

/**
 * Read the mirror configuration from the environment.
 *
 * Unset or unrecognized `SLACK_MIRROR_MODE` resolves to `off`: the feature
 * ships inert, and a typo fails closed rather than posting unexpectedly.
 */
export function readSlackMirrorConfig(env: NodeJS.ProcessEnv = process.env): SlackMirrorConfig {
    const raw = (env.SLACK_MIRROR_MODE ?? 'off').trim().toLowerCase();
    const mode: SlackMirrorMode = raw === 'live' || raw === 'shadow' ? raw : 'off';

    // Failing closed is right, but doing it silently is not: a typo like
    // SLACK_MIRROR_MODE=on would otherwise look identical to "deliberately off".
    if (raw !== 'off' && mode === 'off') {
        console.error(
            `[Slack Mirror] SLACK_MIRROR_MODE="${raw}" is not one of off|shadow|live — ` +
                'treating it as off. The mirror will not run.',
        );
    }

    return {
        mode,
        channelId: env.SLACK_MIRROR_CHANNEL_ID?.trim() || null,
        token: env.SLACK_BOT_TOKEN?.trim() || null,
    };
}

/**
 * Whether the mirror should do anything at all for this process.
 *
 * Used by the producers (inbound handler, AI response handler) so a disabled
 * mirror never enqueues jobs, and by the consumer as its first check.
 *
 * `shadow` counts as enabled — it exists to be exercised, and its whole value
 * is producing log lines showing what a live run would post. Only the channel
 * ID is required for that, not the token.
 *
 * Deliberately does NOT require a token. This predicate gates the PRODUCERS,
 * which run inside the bots and only enqueue — they never post, so demanding a
 * Slack token there would either spread the bot token across services that have
 * no use for it, or (if it is absent) make the bots silently enqueue nothing and
 * leave the mirror dead with no signal anywhere. The token is the CONSUMER's
 * requirement: `handleSlackMirror` reports a permanent, non-retrying failure that
 * names the missing variable, so a misconfigured `live` is loud instead of quiet.
 */
export function isSlackMirrorEnabled(config: SlackMirrorConfig): boolean {
    if (config.mode === 'off') return false;
    // Falsy, not `=== null`: readSlackMirrorConfig normalizes blanks to null, but
    // a config built by hand (tests, a future caller) can carry '' and an empty
    // channel id must never read as configured.
    return Boolean(config.channelId);
}

/**
 * Whether this config can actually post — the CONSUMER's stricter check.
 *
 * `shadow` posts nothing, so it needs no token. `live` does.
 */
export function canSlackMirrorPost(config: SlackMirrorConfig): boolean {
    if (!isSlackMirrorEnabled(config)) return false;
    return config.mode === 'shadow' || Boolean(config.token);
}

/**
 * Ticket sources the mirror covers.
 *
 * An ALLOWLIST, deliberately. The mirror exists to bring GitHub and Discord
 * tickets into Slack; a denylist ("everything except SLACK") silently pulled in
 * TEAMS, EMAIL, WEB, MANUAL, and LINEAR tickets the feature was never specified
 * for. Slack-sourced tickets are excluded because they already live in Slack.
 *
 * Values are the string forms of `TicketSource` (shared/src/types.ts). This
 * module deliberately does not import that enum: it is consumed by both the
 * queue package and the platform producers, and staying string-keyed keeps it
 * free of a cycle through the platform barrel.
 */
const MIRRORABLE_SOURCES: ReadonlySet<string> = new Set([
    'DISCORD',
    'GITHUB_ISSUE',
    'GITHUB_DISCUSSION',
]);

/**
 * Whether a ticket from this source should be mirrored.
 *
 * Both producers MUST route through this. The rule previously lived in the
 * inbound producer only, so the AI-reply producer mirrored everything — which
 * is how a Slack-sourced ticket ended up opening a thread in the mirror channel.
 */
export function isMirrorableSource(source: string): boolean {
    return MIRRORABLE_SOURCES.has(source);
}

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTicketFindUnique = vi.fn();
const mockMessageFindUnique = vi.fn();
const mockLinkFindUnique = vi.fn();
const mockLinkCreate = vi.fn();
const mockLinkUpdate = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        ticket: { findUnique: (...a: unknown[]) => mockTicketFindUnique(...a) },
        message: { findUnique: (...a: unknown[]) => mockMessageFindUnique(...a) },
        ticketExternalLink: {
            findUnique: (...a: unknown[]) => mockLinkFindUnique(...a),
            create: (...a: unknown[]) => mockLinkCreate(...a),
            update: (...a: unknown[]) => mockLinkUpdate(...a),
        },
    },
}));

import { handleSlackMirror, SLACK_MIRROR_PLUGIN } from '../slack-mirror.js';
import {
    readSlackMirrorConfig,
    isSlackMirrorEnabled,
    canSlackMirrorPost,
    isMirrorableSource,
} from '@copilotkit/outpost/shared/platforms';
import type { SlackMirrorConfig } from '@copilotkit/outpost/shared/platforms';

const context = { reportProgress: vi.fn().mockResolvedValue(undefined), jobId: 'job-1' };

const TICKET = {
    id: 'tkt-1',
    displayId: 'OUT-101',
    title: 'Sidebar crashes on mount',
    description: 'Repro: render CopilotSidebar with no props.',
    source: 'GITHUB_ISSUE',
    sourceUrl: 'https://github.com/CopilotKit/CopilotKit/issues/42',
};

const liveConfig: SlackMirrorConfig = { mode: 'live', channelId: 'C0MIRROR', token: 'xoxb-1' };

function makePoster(ts = '1712345678.000100') {
    const postMessage = vi.fn().mockResolvedValue({ ts });
    return { poster: { postMessage }, postMessage };
}

describe('readSlackMirrorConfig', () => {
    it('defaults to off when the mode is unset', () => {
        expect(readSlackMirrorConfig({}).mode).toBe('off');
    });

    it('fails closed on an unrecognized mode rather than posting', () => {
        expect(readSlackMirrorConfig({ SLACK_MIRROR_MODE: 'on' }).mode).toBe('off');
        expect(readSlackMirrorConfig({ SLACK_MIRROR_MODE: 'LIVE' }).mode).toBe('live');
    });

    it('treats a blank channel ID as unset', () => {
        expect(readSlackMirrorConfig({ SLACK_MIRROR_CHANNEL_ID: '   ' }).channelId).toBeNull();
    });
});

describe('isSlackMirrorEnabled', () => {
    it('is disabled when off, even with a channel configured', () => {
        expect(isSlackMirrorEnabled({ mode: 'off', channelId: 'C1', token: 'x' })).toBe(false);
    });

    it('is disabled when live but no channel is configured', () => {
        expect(isSlackMirrorEnabled({ mode: 'live', channelId: null, token: 'x' })).toBe(false);
    });

    it('is enabled in shadow without a token, since shadow never posts', () => {
        expect(isSlackMirrorEnabled({ mode: 'shadow', channelId: 'C1', token: null })).toBe(true);
    });
});

describe('handleSlackMirror', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockTicketFindUnique.mockResolvedValue(TICKET);
        mockLinkFindUnique.mockResolvedValue(null);
        mockLinkCreate.mockResolvedValue({});
        mockLinkUpdate.mockResolvedValue({});
    });

    it('posts nothing and touches no DB when the mirror is off', async () => {
        const { poster, postMessage } = makePoster();
        const result = await handleSlackMirror({ ticketId: 'tkt-1', kind: 'ticket' }, context, {
            config: { mode: 'off', channelId: 'C0MIRROR', token: 'xoxb-1' },
            poster,
        });

        expect(result).toEqual({ success: true, data: { skipped: 'mirror-disabled' } });
        expect(postMessage).not.toHaveBeenCalled();
        expect(mockTicketFindUnique).not.toHaveBeenCalled();
    });

    it('opens a thread and records the link under plugin slack', async () => {
        const { poster, postMessage } = makePoster('1712345678.000100');

        const result = await handleSlackMirror({ ticketId: 'tkt-1', kind: 'ticket' }, context, {
            config: liveConfig,
            poster,
        });

        expect(result.success).toBe(true);
        expect(postMessage).toHaveBeenCalledTimes(1);
        const posted = postMessage.mock.calls[0][0];
        expect(posted.channel).toBe('C0MIRROR');
        expect(posted.thread_ts).toBeUndefined();
        expect(posted.text).toContain('OUT-101');
        expect(posted.text).toContain('Sidebar crashes on mount');
        expect(posted.text).toContain('https://github.com/CopilotKit/CopilotKit/issues/42');

        expect(mockLinkCreate).toHaveBeenCalledTimes(1);
        expect(mockLinkCreate.mock.calls[0][0].data).toMatchObject({
            ticketId: 'tkt-1',
            plugin: SLACK_MIRROR_PLUGIN,
            externalId: 'C0MIRROR:1712345678.000100',
        });
    });

    it('does not open a second thread for an already-mirrored ticket', async () => {
        mockLinkFindUnique.mockResolvedValue({ externalId: 'C0MIRROR:111.222' });
        const { poster, postMessage } = makePoster();

        const result = await handleSlackMirror({ ticketId: 'tkt-1', kind: 'ticket' }, context, {
            config: liveConfig,
            poster,
        });

        expect(result).toEqual({ success: true, data: { skipped: 'already-mirrored' } });
        expect(postMessage).not.toHaveBeenCalled();
        expect(mockLinkCreate).not.toHaveBeenCalled();
    });

    it('threads a reply under the existing ticket thread', async () => {
        mockLinkFindUnique.mockResolvedValue({ externalId: 'C0MIRROR:111.222' });
        mockMessageFindUnique.mockResolvedValue({
            id: 'msg-9',
            author: 'octocat (12345)',
            content: 'Still broken on 1.10.2',
            isAiGenerated: false,
        });
        const { poster, postMessage } = makePoster();

        const result = await handleSlackMirror(
            { ticketId: 'tkt-1', kind: 'reply', messageId: 'msg-9' },
            context,
            { config: liveConfig, poster },
        );

        expect(result.success).toBe(true);
        expect(postMessage).toHaveBeenCalledTimes(1);
        const posted = postMessage.mock.calls[0][0];
        expect(posted.thread_ts).toBe('111.222');
        expect(posted.text).toContain('Still broken on 1.10.2');
        expect(mockLinkCreate).not.toHaveBeenCalled();
    });

    it('opens the thread first when a reply arrives with no thread yet', async () => {
        mockLinkFindUnique.mockResolvedValue(null);
        mockMessageFindUnique.mockResolvedValue({
            id: 'msg-9',
            author: 'octocat (12345)',
            content: 'Still broken',
            isAiGenerated: false,
        });
        const { poster, postMessage } = makePoster('999.111');

        const result = await handleSlackMirror(
            { ticketId: 'tkt-1', kind: 'reply', messageId: 'msg-9' },
            context,
            { config: liveConfig, poster },
        );

        expect(result.success).toBe(true);
        expect(postMessage).toHaveBeenCalledTimes(2);
        expect(postMessage.mock.calls[0][0].thread_ts).toBeUndefined();
        expect(postMessage.mock.calls[1][0].thread_ts).toBe('999.111');
        expect(mockLinkCreate).toHaveBeenCalledTimes(1);
    });

    /**
     * Each undelivered cause must render its OWN reason. The handler used to
     * print "withheld or shadow mode" for every one of them, naming a cause that
     * was not established for four of the five.
     */
    it.each([
        ['shadow', 'SHADOW_MODE was on'],
        ['withheld', 'groundedness gate withheld'],
        ['post-failed', 'posting to the source platform failed'],
        ['no-adapter', 'no delivery was attempted'],
    ] as const)('renders the %s reason on an AI reply', async (delivery, expected) => {
        mockLinkFindUnique.mockResolvedValue({ externalId: 'C0MIRROR:111.222' });
        mockMessageFindUnique.mockResolvedValue({
            id: 'msg-ai',
            author: 'outpost-ai',
            content: '## Bug Confirmed…',
            isAiGenerated: true,
        });
        const { poster, postMessage } = makePoster();

        await handleSlackMirror(
            { ticketId: 'tkt-1', kind: 'reply', messageId: 'msg-ai', delivery },
            context,
            { config: liveConfig, poster },
        );

        const text = postMessage.mock.calls[0][0].text;
        expect(text).toContain(expected);
        expect(text).toContain('not sent');
    });

    it('does not mark a delivered AI reply', async () => {
        mockLinkFindUnique.mockResolvedValue({ externalId: 'C0MIRROR:111.222' });
        mockMessageFindUnique.mockResolvedValue({
            id: 'msg-ai',
            author: 'outpost-ai',
            content: 'Here is the fix',
            isAiGenerated: true,
        });
        const { poster, postMessage } = makePoster();

        await handleSlackMirror(
            { ticketId: 'tkt-1', kind: 'reply', messageId: 'msg-ai', delivery: 'delivered' },
            context,
            { config: liveConfig, poster },
        );

        const text = postMessage.mock.calls[0][0].text;
        expect(text).not.toContain('not sent');
        expect(text).not.toContain('unconfirmed');
    });

    // Unknown is not "fine": an AI reply whose fate the payload never recorded
    // must not read as delivered.
    it('renders an AI reply with no delivery status as unconfirmed', async () => {
        mockLinkFindUnique.mockResolvedValue({ externalId: 'C0MIRROR:111.222' });
        mockMessageFindUnique.mockResolvedValue({
            id: 'msg-ai',
            author: 'outpost-ai',
            content: 'Here is the fix',
            isAiGenerated: true,
        });
        const { poster, postMessage } = makePoster();

        await handleSlackMirror(
            { ticketId: 'tkt-1', kind: 'reply', messageId: 'msg-ai' },
            context,
            { config: liveConfig, poster },
        );

        expect(postMessage.mock.calls[0][0].text).toContain('delivery unconfirmed');
    });

    // A human reply is delivered by definition — no label belongs on it.
    it('puts no delivery note on a community reply', async () => {
        mockLinkFindUnique.mockResolvedValue({ externalId: 'C0MIRROR:111.222' });
        mockMessageFindUnique.mockResolvedValue({
            id: 'msg-9',
            author: 'octocat (12345)',
            content: 'Still broken',
            isAiGenerated: false,
        });
        const { poster, postMessage } = makePoster();

        await handleSlackMirror({ ticketId: 'tkt-1', kind: 'reply', messageId: 'msg-9' }, context, {
            config: liveConfig,
            poster,
        });

        const text = postMessage.mock.calls[0][0].text;
        expect(text).not.toContain('not sent');
        expect(text).not.toContain('unconfirmed');
    });

    it('shadow mode posts nothing and records no link', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { poster, postMessage } = makePoster();

        const result = await handleSlackMirror({ ticketId: 'tkt-1', kind: 'ticket' }, context, {
            config: { mode: 'shadow', channelId: 'C0MIRROR', token: null },
            poster,
        });

        expect(result.success).toBe(true);
        expect(postMessage).not.toHaveBeenCalled();
        expect(mockLinkCreate).not.toHaveBeenCalled();
        expect(logSpy.mock.calls.flat().join(' ')).toContain('would open thread');
        logSpy.mockRestore();
    });

    // ── Idempotent link lifecycle ────────────────────────────────────────────

    it('loses the create race without opening a second thread and replies on the winner ts', async () => {
        // Both jobs for this ticket read "no link", so both post a root message.
        // The loser's create hits @@unique([ticketId, plugin]).
        mockLinkFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
            externalId: 'C0MIRROR:winner.0001',
        });
        mockLinkCreate.mockRejectedValue(
            Object.assign(new Error('Unique constraint'), {
                code: 'P2002',
            }),
        );
        mockMessageFindUnique.mockResolvedValue({
            id: 'msg-9',
            author: 'octocat (12345)',
            content: 'Still broken',
            isAiGenerated: false,
        });
        const { poster, postMessage } = makePoster('loser.0002');

        const result = await handleSlackMirror(
            { ticketId: 'tkt-1', kind: 'reply', messageId: 'msg-9' },
            context,
            { config: liveConfig, poster },
        );

        expect(result.success).toBe(true);
        expect(mockLinkCreate).toHaveBeenCalledTimes(1);
        expect(mockLinkUpdate).not.toHaveBeenCalled();
        // The reply threads under the winner's ts, not the loser's orphaned post.
        const reply = postMessage.mock.calls.at(-1)![0];
        expect(reply.thread_ts).toBe('winner.0001');
    });

    it('repairs a malformed link with an update instead of a second create', async () => {
        mockLinkFindUnique.mockResolvedValue({ externalId: 'no-colon-here' });
        const { poster, postMessage } = makePoster('repair.0003');

        const result = await handleSlackMirror({ ticketId: 'tkt-1', kind: 'ticket' }, context, {
            config: liveConfig,
            poster,
        });

        expect(result.success).toBe(true);
        expect(postMessage).toHaveBeenCalledTimes(1);
        expect(mockLinkCreate).not.toHaveBeenCalled();
        expect(mockLinkUpdate).toHaveBeenCalledTimes(1);
        const update = mockLinkUpdate.mock.calls[0][0];
        expect(update.where).toEqual({
            ticketId_plugin: { ticketId: 'tkt-1', plugin: SLACK_MIRROR_PLUGIN },
        });
        expect(update.data).toMatchObject({ externalId: 'C0MIRROR:repair.0003' });
    });

    it('replies in the channel recorded on the link, not the currently configured one', async () => {
        mockLinkFindUnique.mockResolvedValue({ externalId: 'C0OLDCHAN:111.222' });
        mockMessageFindUnique.mockResolvedValue({
            id: 'msg-9',
            author: 'octocat (12345)',
            content: 'Still broken',
            isAiGenerated: false,
        });
        const { poster, postMessage } = makePoster();

        const result = await handleSlackMirror(
            { ticketId: 'tkt-1', kind: 'reply', messageId: 'msg-9' },
            context,
            { config: { ...liveConfig, channelId: 'C0NEWCHAN' }, poster },
        );

        expect(result.success).toBe(true);
        expect(postMessage).toHaveBeenCalledTimes(1);
        expect(postMessage.mock.calls[0][0]).toMatchObject({
            channel: 'C0OLDCHAN',
            thread_ts: '111.222',
        });
    });

    it('a duplicate reply job opens no thread and writes no link', async () => {
        mockLinkFindUnique.mockResolvedValue({ externalId: 'C0MIRROR:111.222' });
        mockMessageFindUnique.mockResolvedValue({
            id: 'msg-9',
            author: 'octocat (12345)',
            content: 'Still broken',
            isAiGenerated: false,
        });
        const { poster, postMessage } = makePoster();

        for (let i = 0; i < 2; i++) {
            const result = await handleSlackMirror(
                { ticketId: 'tkt-1', kind: 'reply', messageId: 'msg-9' },
                context,
                { config: liveConfig, poster },
            );
            expect(result.success).toBe(true);
        }

        // Two reply posts, but never a root post and never a link write.
        expect(postMessage).toHaveBeenCalledTimes(2);
        for (const [args] of postMessage.mock.calls) {
            expect(args.thread_ts).toBe('111.222');
        }
        expect(mockLinkCreate).not.toHaveBeenCalled();
        expect(mockLinkUpdate).not.toHaveBeenCalled();
    });

    it('fails the job when the ticket is gone', async () => {
        mockTicketFindUnique.mockResolvedValue(null);
        const { poster } = makePoster();

        const result = await handleSlackMirror({ ticketId: 'tkt-gone', kind: 'ticket' }, context, {
            config: liveConfig,
            poster,
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('tkt-gone');
        expect(result.error).toContain('not found');
    });

    it('fails a reply job that carries no messageId', async () => {
        mockLinkFindUnique.mockResolvedValue({ externalId: 'C0MIRROR:111.222' });
        const { poster } = makePoster();

        const result = await handleSlackMirror({ ticketId: 'tkt-1', kind: 'reply' }, context, {
            config: liveConfig,
            poster,
        });

        expect(result.success).toBe(false);
        // Assert the FIELD name. The original assertion here was
        // toContain('missing'), which matched the ticket id rather than the
        // message — it passed for the wrong reason.
        expect(result.error).toContain('messageId');
        expect(result.retryable).toBe(false);
    });
    // ── Validation owes no side effects ──────────────────────────────────────
    // A reply job used to reach the thread-opening post BEFORE discovering it
    // had no messageId, so every retry posted another root message to Slack.

    it('posts nothing when a reply job carries no messageId', async () => {
        mockLinkFindUnique.mockResolvedValue(null);
        const { poster, postMessage } = makePoster();

        const result = await handleSlackMirror({ ticketId: 'tkt-1', kind: 'reply' }, context, {
            config: liveConfig,
            poster,
        });

        expect(result.success).toBe(false);
        expect(result.retryable).toBe(false);
        expect(postMessage).not.toHaveBeenCalled();
        expect(mockLinkCreate).not.toHaveBeenCalled();
    });

    it('posts nothing when a reply job names a message that does not exist', async () => {
        mockLinkFindUnique.mockResolvedValue(null);
        mockMessageFindUnique.mockResolvedValue(null);
        const { poster, postMessage } = makePoster();

        const result = await handleSlackMirror(
            { ticketId: 'tkt-1', kind: 'reply', messageId: 'msg-gone' },
            context,
            { config: liveConfig, poster },
        );

        expect(result.success).toBe(false);
        expect(result.retryable).toBe(false);
        expect(result.error).toContain('msg-gone');
        expect(postMessage).not.toHaveBeenCalled();
    });

    // ── Permanent Slack errors must not burn retries ─────────────────────────

    it('reports not_in_channel as permanent, with the remedy', async () => {
        mockLinkFindUnique.mockResolvedValue(null);
        const postMessage = vi.fn().mockRejectedValue(
            Object.assign(new Error('An API error occurred'), {
                data: { error: 'not_in_channel' },
            }),
        );

        const result = await handleSlackMirror({ ticketId: 'tkt-1', kind: 'ticket' }, context, {
            config: liveConfig,
            poster: { postMessage },
        });

        expect(result.success).toBe(false);
        expect(result.retryable).toBe(false);
        expect(result.error).toContain('not_in_channel');
        expect(result.error).toContain('invite');
        expect(mockLinkCreate).not.toHaveBeenCalled();
    });

    it('lets a transient Slack error retry', async () => {
        mockLinkFindUnique.mockResolvedValue(null);
        const postMessage = vi.fn().mockRejectedValue(new Error('ratelimited'));

        await expect(
            handleSlackMirror({ ticketId: 'tkt-1', kind: 'ticket' }, context, {
                config: liveConfig,
                poster: { postMessage },
            }),
        ).rejects.toThrow('ratelimited');
    });
});

describe('canSlackMirrorPost — the consumer needs a token, the producers do not', () => {
    // The producer gate must NOT require a token: the bots only enqueue, and
    // demanding a Slack token there would either spread it to services that
    // never post or leave the mirror silently dead.
    it('stays enabled for the producers when live has no token', () => {
        expect(isSlackMirrorEnabled({ mode: 'live', channelId: 'C1', token: null })).toBe(true);
    });

    it('cannot post when live has no token', () => {
        expect(canSlackMirrorPost({ mode: 'live', channelId: 'C1', token: null })).toBe(false);
    });

    it('can post in shadow with no token, because shadow posts nothing', () => {
        expect(canSlackMirrorPost({ mode: 'shadow', channelId: 'C1', token: null })).toBe(true);
    });

    it('can post when live has a token', () => {
        expect(canSlackMirrorPost({ mode: 'live', channelId: 'C1', token: 'xoxb-1' })).toBe(true);
    });

    it('treats an empty channel id as unset', () => {
        expect(isSlackMirrorEnabled({ mode: 'live', channelId: '', token: 'x' })).toBe(false);
    });
});

describe('isMirrorableSource', () => {
    it('covers GitHub and Discord only', () => {
        expect(isMirrorableSource('DISCORD')).toBe(true);
        expect(isMirrorableSource('GITHUB_ISSUE')).toBe(true);
        expect(isMirrorableSource('GITHUB_DISCUSSION')).toBe(true);
    });

    // The old denylist ("everything except SLACK") silently mirrored these.
    it.each(['SLACK', 'TEAMS', 'EMAIL', 'WEB', 'MANUAL', 'LINEAR', 'ORCA'])(
        'excludes %s',
        (source) => {
            expect(isMirrorableSource(source)).toBe(false);
        },
    );
});

describe('handleSlackMirror — permanent vs retryable', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockTicketFindUnique.mockResolvedValue(TICKET);
        mockLinkFindUnique.mockResolvedValue(null);
        mockLinkCreate.mockResolvedValue({});
        mockLinkUpdate.mockResolvedValue({});
    });

    // The post landed but Slack gave us no ts. Retrying would post again.
    it('does not retry when Slack accepts the post but returns no ts', async () => {
        const postMessage = vi.fn().mockResolvedValue({});

        const result = await handleSlackMirror({ ticketId: 'tkt-1', kind: 'ticket' }, context, {
            config: liveConfig,
            poster: { postMessage },
        });

        expect(result.success).toBe(false);
        expect(result.retryable).toBe(false);
        expect(mockLinkCreate).not.toHaveBeenCalled();
    });

    // A deleted ticket IS retryable on purpose: the producers enqueue outside the
    // ticket's transaction, so a worker can legitimately arrive first.
    it('leaves a missing ticket retryable', async () => {
        mockTicketFindUnique.mockResolvedValue(null);
        const { poster } = makePoster();

        const result = await handleSlackMirror({ ticketId: 'tkt-gone', kind: 'ticket' }, context, {
            config: liveConfig,
            poster,
        });

        expect(result.success).toBe(false);
        expect(result.retryable).toBeUndefined();
    });

    it('rejects an unknown kind without posting', async () => {
        const { poster, postMessage } = makePoster();

        const result = await handleSlackMirror(
            { ticketId: 'tkt-1', kind: 'bogus' as 'ticket' },
            context,
            { config: liveConfig, poster },
        );

        expect(result.success).toBe(false);
        expect(result.retryable).toBe(false);
        expect(postMessage).not.toHaveBeenCalled();
    });

    it('reports live-without-token as a permanent misconfiguration', async () => {
        const { poster, postMessage } = makePoster();

        const result = await handleSlackMirror({ ticketId: 'tkt-1', kind: 'ticket' }, context, {
            config: { mode: 'live', channelId: 'C0MIRROR', token: null },
            poster,
        });

        expect(result.success).toBe(false);
        expect(result.retryable).toBe(false);
        expect(result.error).toContain('SLACK_BOT_TOKEN');
        expect(postMessage).not.toHaveBeenCalled();
    });
});

describe('handleSlackMirror — untrusted text', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockTicketFindUnique.mockResolvedValue({
            ...TICKET,
            title: 'Crash <script> & more',
            description: 'See <https://evil.example|click me> & <@U123>',
        });
        mockLinkFindUnique.mockResolvedValue(null);
        mockLinkCreate.mockResolvedValue({});
    });

    // Ticket bodies come from public issue trackers and Discord. Raw
    // interpolation let a reporter inject links and mentions into an internal
    // channel.
    it('escapes Slack markup control characters in ticket text', async () => {
        const { poster, postMessage } = makePoster();

        await handleSlackMirror({ ticketId: 'tkt-1', kind: 'ticket' }, context, {
            config: liveConfig,
            poster,
        });

        const text = postMessage.mock.calls[0][0].text;
        expect(text).not.toContain('<https://evil.example|click me>');
        expect(text).not.toContain('<@U123>');
        expect(text).toContain('&lt;');
        expect(text).toContain('&amp;');
    });

    // An older queued payload, or drift after the union changes, must not render
    // the literal string "undefined" into Slack.
    it('renders an unrecognized delivery value as unconfirmed', async () => {
        mockLinkFindUnique.mockResolvedValue({ externalId: 'C0MIRROR:111.222' });
        mockMessageFindUnique.mockResolvedValue({
            id: 'msg-ai',
            author: 'outpost-ai',
            content: 'answer',
            isAiGenerated: true,
        });
        const { poster, postMessage } = makePoster();

        await handleSlackMirror(
            {
                ticketId: 'tkt-1',
                kind: 'reply',
                messageId: 'msg-ai',
                delivery: 'not-a-real-status' as 'delivered',
            },
            context,
            { config: liveConfig, poster },
        );

        const text = postMessage.mock.calls[0][0].text;
        expect(text).toContain('delivery unconfirmed');
        expect(text).not.toContain('undefined');
    });
});

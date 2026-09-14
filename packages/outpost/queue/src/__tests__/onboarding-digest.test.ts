import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing the handler
const mockOnboardingMember = {
    findMany: vi.fn(),
};

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        onboardingMember: mockOnboardingMember,
    },
}));

// Partial mock: everything real except the one function this file needs to
// pin. The previous version listed its exports explicitly, which meant
// re-implementing `isShadowMode` — so a diff whose whole point was deleting
// three copies of the comparison added a fourth, and it had already drifted
// (no EXPLICITLY_ON, no warn). Spreading the real module means the SHADOW_MODE
// tests below exercise the shipped function instead of a lookalike.
vi.mock('@copilotkit/outpost/shared', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@copilotkit/outpost/shared')>()),
    computeFunnelMetrics: vi.fn().mockReturnValue({
        stageCounts: { JOINED: 3, CONTACTED: 2, RESPONDED: 1, MEETING_BOOKED: 0 },
        conversionRates: {
            joinedToContacted: 66.67,
            contactedToResponded: 50,
            respondedToMeetingBooked: 0,
        },
        totalMembers: 3,
    }),
}));

const { handleOnboardingDigest } = await import('../handlers/onboarding-digest.js');

function makeContext() {
    return {
        jobId: 'job-digest-1',
        reportProgress: vi.fn().mockResolvedValue(undefined),
    };
}

function makeMemberRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'om-1',
        discordId: 'discord-001',
        username: 'alice#1234',
        joinedAt: new Date('2026-04-15T10:00:00Z'),
        funnelStage: 'JOINED',
        contacted: false,
        responded: false,
        meetingBooked: false,
        createdAt: new Date('2026-04-15T10:00:00Z'),
        updatedAt: new Date('2026-04-15T10:00:00Z'),
        ...overrides,
    };
}

describe('handleOnboardingDigest', () => {
    let originalDiscordToken: string | undefined;
    let originalChannelId: string | undefined;
    let originalShadowMode: string | undefined;

    beforeEach(() => {
        vi.clearAllMocks();
        originalDiscordToken = process.env.DISCORD_TOKEN;
        originalChannelId = process.env.DISCORD_DIGEST_CHANNEL_ID;
        originalShadowMode = process.env.SHADOW_MODE;
        // Default: no Discord env vars set (development fallback)
        delete process.env.DISCORD_TOKEN;
        delete process.env.DISCORD_DIGEST_CHANNEL_ID;
        delete process.env.SHADOW_MODE;
    });

    afterEach(() => {
        if (originalDiscordToken !== undefined) {
            process.env.DISCORD_TOKEN = originalDiscordToken;
        } else {
            delete process.env.DISCORD_TOKEN;
        }
        if (originalChannelId !== undefined) {
            process.env.DISCORD_DIGEST_CHANNEL_ID = originalChannelId;
        } else {
            delete process.env.DISCORD_DIGEST_CHANNEL_ID;
        }
        if (originalShadowMode !== undefined) {
            process.env.SHADOW_MODE = originalShadowMode;
        } else {
            delete process.env.SHADOW_MODE;
        }
    });

    it('queries members for the given date range', async () => {
        mockOnboardingMember.findMany
            .mockResolvedValueOnce([makeMemberRow()]) // date-filtered query
            .mockResolvedValueOnce([makeMemberRow()]); // all-members query for metrics

        const ctx = makeContext();
        const result = await handleOnboardingDigest({ date: '2026-04-15' }, ctx);

        expect(result.success).toBe(true);
        expect(result.data?.date).toBe('2026-04-15');
        expect(result.data?.newMemberCount).toBe(1);

        // First call should filter by date range
        const firstCall = mockOnboardingMember.findMany.mock.calls[0][0];
        expect(firstCall.where.joinedAt.gte).toBeInstanceOf(Date);
        expect(firstCall.where.joinedAt.lt).toBeInstanceOf(Date);
    });

    it('handles zero new members gracefully', async () => {
        mockOnboardingMember.findMany
            .mockResolvedValueOnce([]) // no members for the day
            .mockResolvedValueOnce([]); // no members overall

        const ctx = makeContext();
        const result = await handleOnboardingDigest({ date: '2026-04-15' }, ctx);

        expect(result.success).toBe(true);
        expect(result.data?.newMemberCount).toBe(0);
    });

    it('reports progress through the job lifecycle', async () => {
        mockOnboardingMember.findMany.mockResolvedValue([]);

        const ctx = makeContext();
        await handleOnboardingDigest({ date: '2026-04-15' }, ctx);

        const progressCalls = ctx.reportProgress.mock.calls.map((c: number[]) => c[0]);
        expect(progressCalls).toEqual([10, 50, 70, 90, 100]);
    });

    it('defaults to current date when payload date is empty', async () => {
        mockOnboardingMember.findMany.mockResolvedValue([]);

        const ctx = makeContext();
        const result = await handleOnboardingDigest({ date: '' }, ctx);

        expect(result.success).toBe(true);
        // The date should be today's date
        expect(result.data?.date).toBe(new Date().toISOString().split('T')[0]);
    });

    it('compiles digest with multiple new members', async () => {
        const members = [
            makeMemberRow({ id: 'om-1', username: 'alice#1234' }),
            makeMemberRow({ id: 'om-2', username: 'bob#5678' }),
            makeMemberRow({ id: 'om-3', username: 'charlie#9012' }),
        ];

        mockOnboardingMember.findMany.mockResolvedValueOnce(members).mockResolvedValueOnce(members);

        const ctx = makeContext();
        const result = await handleOnboardingDigest({ date: '2026-04-15' }, ctx);

        expect(result.success).toBe(true);
        expect(result.data?.newMemberCount).toBe(3);
    });

    it('posts digest to Discord when channel ID is configured', async () => {
        process.env.DISCORD_TOKEN = 'test-bot-token';
        process.env.DISCORD_DIGEST_CHANNEL_ID = '1234567890';

        mockOnboardingMember.findMany
            .mockResolvedValueOnce([makeMemberRow()])
            .mockResolvedValueOnce([makeMemberRow()]);

        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ id: 'msg-1' }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const ctx = makeContext();
        const result = await handleOnboardingDigest({ date: '2026-04-15' }, ctx);

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toBe('https://discord.com/api/v10/channels/1234567890/messages');
        expect(options.method).toBe('POST');
        expect(options.headers.Authorization).toBe('Bot test-bot-token');
        const body = JSON.parse(options.body);
        expect(body.content).toContain('Onboarding Digest');

        vi.unstubAllGlobals();
    });

    it('falls back to console.log when channel ID is not set', async () => {
        // No DISCORD_DIGEST_CHANNEL_ID set
        mockOnboardingMember.findMany.mockResolvedValue([]);

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        const ctx = makeContext();
        const result = await handleOnboardingDigest({ date: '2026-04-15' }, ctx);

        expect(result.success).toBe(true);
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('DISCORD_DIGEST_CHANNEL_ID not set'),
        );

        consoleSpy.mockRestore();
    });

    it('does not post to Discord when SHADOW_MODE is enabled', async () => {
        process.env.DISCORD_TOKEN = 'test-bot-token';
        process.env.DISCORD_DIGEST_CHANNEL_ID = '1234567890';
        process.env.SHADOW_MODE = 'true';

        mockOnboardingMember.findMany
            .mockResolvedValueOnce([makeMemberRow()])
            .mockResolvedValueOnce([makeMemberRow()]);

        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ id: 'msg-1' }),
        });
        vi.stubGlobal('fetch', mockFetch);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        const ctx = makeContext();
        const result = await handleOnboardingDigest({ date: '2026-04-15' }, ctx);

        expect(result.success).toBe(true);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Shadow mode'));

        consoleSpy.mockRestore();
        vi.unstubAllGlobals();
    });

    // The fence. Every other shadow test here uses `'true'`, which is the one
    // spelling that behaves identically before and after the fail-closed change
    // — so reverting `isShadowMode` to `=== 'true'` left this whole file green.
    // These are the spellings that used to post for real.
    it.each(['1', 'TRUE', 'yes', 'on', ' true ', 'YES'])(
        'does not post to Discord when SHADOW_MODE=%j',
        async (value) => {
            process.env.DISCORD_TOKEN = 'test-bot-token';
            process.env.DISCORD_DIGEST_CHANNEL_ID = '1234567890';
            process.env.SHADOW_MODE = value;

            mockOnboardingMember.findMany
                .mockResolvedValueOnce([makeMemberRow()])
                .mockResolvedValueOnce([makeMemberRow()]);

            const mockFetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ id: 'msg-1' }),
            });
            vi.stubGlobal('fetch', mockFetch);
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            const ctx = makeContext();
            const result = await handleOnboardingDigest({ date: '2026-04-15' }, ctx);

            expect(result.success).toBe(true);
            expect(mockFetch).not.toHaveBeenCalled();
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Shadow mode'));

            consoleSpy.mockRestore();
            vi.unstubAllGlobals();
        },
    );

    it('posts to Discord when SHADOW_MODE is explicitly false', async () => {
        process.env.DISCORD_TOKEN = 'test-bot-token';
        process.env.DISCORD_DIGEST_CHANNEL_ID = '1234567890';
        process.env.SHADOW_MODE = 'false';

        mockOnboardingMember.findMany
            .mockResolvedValueOnce([makeMemberRow()])
            .mockResolvedValueOnce([makeMemberRow()]);

        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ id: 'msg-1' }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const ctx = makeContext();
        const result = await handleOnboardingDigest({ date: '2026-04-15' }, ctx);

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        vi.unstubAllGlobals();
    });

    it('throws when Discord API returns an error', async () => {
        process.env.DISCORD_TOKEN = 'test-bot-token';
        process.env.DISCORD_DIGEST_CHANNEL_ID = '1234567890';

        mockOnboardingMember.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            text: async () => '{"message": "Missing Access"}',
        });
        vi.stubGlobal('fetch', mockFetch);

        const ctx = makeContext();
        await expect(handleOnboardingDigest({ date: '2026-04-15' }, ctx)).rejects.toThrow(
            'Discord API error 403',
        );

        vi.unstubAllGlobals();
    });
});

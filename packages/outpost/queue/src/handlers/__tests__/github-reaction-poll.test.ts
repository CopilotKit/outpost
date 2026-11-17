import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

const mockMessageFindMany = vi.fn();
const mockMessageUpdate = vi.fn();
const mockCreateJob = vi.fn();
const mockListCommentReactions = vi.fn();
const mockCreateGithubClient = vi.fn().mockReturnValue({});
const mockIsRepoVisible = vi.fn();

vi.mock('@copilotkit/outpost/db', () => ({
    prisma: {
        message: {
            findMany: (...args: unknown[]) => mockMessageFindMany(...args),
            update: (...args: unknown[]) => mockMessageUpdate(...args),
        },
    },
}));

vi.mock('@copilotkit/outpost/shared', () => ({
    createGithubClient: (...args: unknown[]) => mockCreateGithubClient(...args),
    listCommentReactions: (...args: unknown[]) => mockListCommentReactions(...args),
    isRepoVisible: (...args: unknown[]) => mockIsRepoVisible(...args),
    isGithubNotFound: (error: unknown) => (error as { status?: unknown } | null)?.status === 404,
}));

vi.mock('../../create-job.js', () => ({
    createJob: (...args: unknown[]) => mockCreateJob(...args),
}));

import {
    handleGithubReactionPoll,
    COMMENT_DELETED_FEEDBACK,
    GITHUB_REACTION_POLL_CONCURRENCY,
} from '../github-reaction-poll.js';
import { JobType } from '../../types.js';

const context = { reportProgress: vi.fn().mockResolvedValue(undefined), jobId: 'job-1' };

describe('handleGithubReactionPoll', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.GITHUB_APP_ID = 'app-1';
        process.env.GITHUB_PRIVATE_KEY = 'key';
        process.env.GITHUB_INSTALLATION_ID = '123';
    });

    it('sets POSITIVE feedback when the reporter reacted +1', async () => {
        mockMessageFindMany.mockResolvedValue([
            {
                id: 'msg-1',
                externalCommentId: '999',
                ticket: { sourceId: 'owner/repo#42', user: { externalId: 'reporter-login' } },
            },
        ]);
        mockListCommentReactions.mockResolvedValue([{ content: '+1', login: 'reporter-login' }]);

        const result = await handleGithubReactionPoll({}, context);

        expect(mockMessageUpdate).toHaveBeenCalledWith({
            where: { id: 'msg-1' },
            data: { feedback: 'POSITIVE' },
        });
        expect(mockCreateJob).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
    });

    it('sets NEGATIVE feedback and enqueues ESCALATION when the reporter reacted -1', async () => {
        mockMessageFindMany.mockResolvedValue([
            {
                id: 'msg-1',
                ticketId: 'ticket-1',
                externalCommentId: '999',
                ticket: { sourceId: 'owner/repo#42', user: { externalId: 'reporter-login' } },
            },
        ]);
        mockListCommentReactions.mockResolvedValue([{ content: '-1', login: 'reporter-login' }]);

        await handleGithubReactionPoll({}, context);

        expect(mockMessageUpdate).toHaveBeenCalledWith({
            where: { id: 'msg-1' },
            data: { feedback: 'NEGATIVE' },
        });
        expect(mockCreateJob).toHaveBeenCalledWith(JobType.ESCALATION, {
            ticketId: 'ticket-1',
            reason: expect.stringContaining('GitHub reaction'),
        });
    });

    it('ignores a reaction from someone other than the reporter', async () => {
        mockMessageFindMany.mockResolvedValue([
            {
                id: 'msg-1',
                externalCommentId: '999',
                ticket: { sourceId: 'owner/repo#42', user: { externalId: 'reporter-login' } },
            },
        ]);
        mockListCommentReactions.mockResolvedValue([{ content: '+1', login: 'someone-else' }]);

        await handleGithubReactionPoll({}, context);

        expect(mockMessageUpdate).not.toHaveBeenCalled();
    });

    it('skips a message with no externalCommentId', async () => {
        mockMessageFindMany.mockResolvedValue([
            {
                id: 'msg-1',
                externalCommentId: null,
                ticket: { sourceId: 'owner/repo#42', user: { externalId: 'reporter-login' } },
            },
        ]);

        await handleGithubReactionPoll({}, context);

        expect(mockListCommentReactions).not.toHaveBeenCalled();
        expect(mockMessageUpdate).not.toHaveBeenCalled();
    });

    it('skips a message gracefully when the ticket has no linked user (ticket.user is null)', async () => {
        mockMessageFindMany.mockResolvedValue([
            {
                id: 'msg-1',
                externalCommentId: '999',
                ticket: { sourceId: 'owner/repo#42', user: null },
            },
        ]);

        const result = await handleGithubReactionPoll({}, context);

        expect(mockListCommentReactions).not.toHaveBeenCalled();
        expect(mockMessageUpdate).not.toHaveBeenCalled();
        expect(mockCreateJob).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ checked: 1, updated: 0, deleted: 0 });
    });

    it('skips a message gracefully when ticket.user.externalId is null', async () => {
        mockMessageFindMany.mockResolvedValue([
            {
                id: 'msg-1',
                externalCommentId: '999',
                ticket: { sourceId: 'owner/repo#42', user: { externalId: null } },
            },
        ]);

        const result = await handleGithubReactionPoll({}, context);

        expect(mockListCommentReactions).not.toHaveBeenCalled();
        expect(mockMessageUpdate).not.toHaveBeenCalled();
        expect(mockCreateJob).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ checked: 1, updated: 0, deleted: 0 });
    });

    it('catches a listCommentReactions rejection, logs, and continues without updating', async () => {
        mockMessageFindMany.mockResolvedValue([
            {
                id: 'msg-1',
                externalCommentId: '999',
                ticket: { sourceId: 'owner/repo#42', user: { externalId: 'reporter-login' } },
            },
        ]);
        mockListCommentReactions.mockRejectedValue(new Error('GitHub API down'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const result = await handleGithubReactionPoll({}, context);

        expect(consoleErrorSpy).toHaveBeenCalled();
        expect(mockMessageUpdate).not.toHaveBeenCalled();
        expect(mockCreateJob).not.toHaveBeenCalled();
        expect(result.success).toBe(true);

        consoleErrorSpy.mockRestore();
    });

    it('returns a failure result and skips GitHub calls when env vars are missing', async () => {
        delete process.env.GITHUB_APP_ID;
        delete process.env.GITHUB_PRIVATE_KEY;
        delete process.env.GITHUB_INSTALLATION_ID;
        mockMessageFindMany.mockResolvedValue([
            {
                id: 'msg-1',
                externalCommentId: '999',
                ticket: { sourceId: 'owner/repo#42', user: { externalId: 'reporter-login' } },
            },
        ]);

        const result = await handleGithubReactionPoll({}, context);

        expect(result).toEqual({
            success: false,
            error: 'GITHUB_APP_ID/GITHUB_PRIVATE_KEY/GITHUB_INSTALLATION_ID not configured',
        });
        expect(mockCreateGithubClient).not.toHaveBeenCalled();
        expect(mockListCommentReactions).not.toHaveBeenCalled();
    });

    it('queries only unresolved AI-generated GitHub messages', async () => {
        mockMessageFindMany.mockResolvedValue([]);

        await handleGithubReactionPoll({}, context);

        expect(mockMessageFindMany).toHaveBeenCalledWith({
            where: {
                isAiGenerated: true,
                feedback: null,
                externalCommentId: { not: null },
                ticket: {
                    source: { in: ['GITHUB_ISSUE'] },
                },
            },
            include: {
                ticket: {
                    select: {
                        id: true,
                        sourceId: true,
                        user: { select: { externalId: true } },
                    },
                },
            },
        });
    });
    describe('GitHub lookup concurrency', () => {
        // Production had 256 pending messages. Read one at a time at ~240ms each,
        // the poll ran past its 30s job timeout on every attempt and dead-lettered.
        function pendingMessages(count: number) {
            return Array.from({ length: count }, (_, i) => ({
                id: `msg-${i}`,
                ticketId: `ticket-${i}`,
                externalCommentId: String(1000 + i),
                ticket: { sourceId: 'owner/repo#42', user: { externalId: 'reporter-login' } },
            }));
        }

        function trackInFlight() {
            const state = { inFlight: 0, peak: 0 };
            mockListCommentReactions.mockImplementation(async () => {
                state.inFlight += 1;
                state.peak = Math.max(state.peak, state.inFlight);
                await new Promise((resolve) => setTimeout(resolve, 5));
                state.inFlight -= 1;
                return [];
            });
            return state;
        }

        it('reads reactions for several messages in parallel instead of one at a time', async () => {
            mockMessageFindMany.mockResolvedValue(pendingMessages(40));
            const state = trackInFlight();

            const result = await handleGithubReactionPoll({}, context);

            expect(state.peak).toBeGreaterThan(1);
            expect(mockListCommentReactions).toHaveBeenCalledTimes(40);
            expect(result).toEqual({
                success: true,
                data: { checked: 40, updated: 0, deleted: 0 },
            });
        });

        it('caps the number of GitHub reads in flight', async () => {
            mockMessageFindMany.mockResolvedValue(pendingMessages(40));
            const state = trackInFlight();

            await handleGithubReactionPoll({}, context);

            expect(state.peak).toBe(GITHUB_REACTION_POLL_CONCURRENCY);
        });

        it('still applies every reporter reaction when reads run in parallel', async () => {
            mockMessageFindMany.mockResolvedValue(pendingMessages(20));
            mockListCommentReactions.mockImplementation(async (_c, _o, _r, commentId: number) => {
                await new Promise((resolve) => setTimeout(resolve, 1));
                if (commentId === 1003) return [{ content: '+1', login: 'reporter-login' }];
                if (commentId === 1017) return [{ content: '-1', login: 'reporter-login' }];
                if (commentId === 1010) throw new Error('Not Found');
                return [];
            });

            const result = await handleGithubReactionPoll({}, context);

            expect(mockMessageUpdate).toHaveBeenCalledTimes(2);
            expect(mockMessageUpdate).toHaveBeenCalledWith({
                where: { id: 'msg-3' },
                data: { feedback: 'POSITIVE' },
            });
            expect(mockMessageUpdate).toHaveBeenCalledWith({
                where: { id: 'msg-17' },
                data: { feedback: 'NEGATIVE' },
            });
            expect(mockCreateJob).toHaveBeenCalledTimes(1);
            expect(mockCreateJob).toHaveBeenCalledWith(JobType.ESCALATION, {
                ticketId: 'ticket-17',
                reason: expect.stringContaining('GitHub reaction'),
            });
            expect(result).toEqual({
                success: true,
                data: { checked: 20, updated: 2, deleted: 0 },
            });
        });
    });
});

describe('handleGithubReactionPoll: comments that 404', () => {
    // Prod polled the same 12 deleted CopilotKit/CopilotKit comments on every run
    // and logged a "Failed to list reactions ... Not Found" error for each, forever.
    function notFound(): Error {
        return Object.assign(new Error('Not Found'), { status: 404 });
    }

    function message(id: string, sourceId = 'owner/repo#42') {
        return {
            id,
            ticketId: `ticket-${id}`,
            externalCommentId: '999',
            ticket: { sourceId, user: { externalId: 'reporter-login' } },
        };
    }

    let consoleErrorSpy: MockInstance<typeof console.error>;
    let consoleLogSpy: MockInstance<typeof console.log>;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.GITHUB_APP_ID = 'app-1';
        process.env.GITHUB_PRIVATE_KEY = 'key';
        process.env.GITHUB_INSTALLATION_ID = '123';
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        consoleLogSpy.mockRestore();
    });

    it('marks a deleted comment so it is not polled again, with one info line and no error', async () => {
        mockMessageFindMany.mockResolvedValue([message('msg-1')]);
        mockListCommentReactions.mockRejectedValue(notFound());
        mockIsRepoVisible.mockResolvedValue(true);

        const result = await handleGithubReactionPoll({}, context);

        expect(mockMessageUpdate).toHaveBeenCalledWith({
            where: { id: 'msg-1' },
            data: { feedback: COMMENT_DELETED_FEEDBACK },
        });
        expect(consoleErrorSpy).not.toHaveBeenCalled();
        const deletedLines = consoleLogSpy.mock.calls.filter((args) =>
            String(args[0]).includes('no longer exists'),
        );
        expect(deletedLines).toHaveLength(1);
        expect(String(deletedLines[0][0])).toContain('msg-1');
        expect(mockCreateJob).not.toHaveBeenCalled();
        expect(result).toEqual({ success: true, data: { checked: 1, updated: 0, deleted: 1 } });
    });

    it('does not mark anything when the repo itself is not visible, and reports the repo once', async () => {
        mockMessageFindMany.mockResolvedValue([message('msg-1'), message('msg-2')]);
        mockListCommentReactions.mockRejectedValue(notFound());
        mockIsRepoVisible.mockResolvedValue(false);

        const result = await handleGithubReactionPoll({}, context);

        expect(mockMessageUpdate).not.toHaveBeenCalled();
        expect(mockIsRepoVisible).toHaveBeenCalledTimes(1);
        expect(mockIsRepoVisible).toHaveBeenCalledWith(expect.anything(), 'owner', 'repo');
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        expect(String(consoleErrorSpy.mock.calls[0][0])).toContain('owner/repo');
        expect(result).toEqual({ success: true, data: { checked: 2, updated: 0, deleted: 0 } });
    });

    it('leaves the message pending and logs an error when the repo check itself fails', async () => {
        mockMessageFindMany.mockResolvedValue([message('msg-1')]);
        mockListCommentReactions.mockRejectedValue(notFound());
        mockIsRepoVisible.mockRejectedValue(new Error('Bad credentials'));

        const result = await handleGithubReactionPoll({}, context);

        expect(mockMessageUpdate).not.toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ success: true, data: { checked: 1, updated: 0, deleted: 0 } });
    });

    it('treats a non-404 failure as transient: logs it, does not mark, does not check the repo', async () => {
        mockMessageFindMany.mockResolvedValue([message('msg-1')]);
        mockListCommentReactions.mockRejectedValue(
            Object.assign(new Error('Server Error'), { status: 502 }),
        );

        await handleGithubReactionPoll({}, context);

        expect(mockIsRepoVisible).not.toHaveBeenCalled();
        expect(mockMessageUpdate).not.toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });
});

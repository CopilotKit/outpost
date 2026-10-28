import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMessageFindMany = vi.fn();
const mockMessageUpdate = vi.fn();
const mockCreateJob = vi.fn();
const mockListCommentReactions = vi.fn();
const mockCreateGithubClient = vi.fn().mockReturnValue({});

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
}));

vi.mock('../../create-job.js', () => ({
    createJob: (...args: unknown[]) => mockCreateJob(...args),
}));

import {
    handleGithubReactionPoll,
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
        expect(result.data).toEqual({ checked: 1, updated: 0 });
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
        expect(result.data).toEqual({ checked: 1, updated: 0 });
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
            expect(result).toEqual({ success: true, data: { checked: 40, updated: 0 } });
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
            expect(result).toEqual({ success: true, data: { checked: 20, updated: 2 } });
        });
    });
});

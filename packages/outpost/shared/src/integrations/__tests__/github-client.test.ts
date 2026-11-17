import { describe, it, expect, vi } from 'vitest';
import { isGithubNotFound, isRepoVisible, listCommentReactions } from '../github-client.js';
import type { GithubReactionClient } from '../github-client.js';

describe('listCommentReactions', () => {
    it('returns each reaction with its content and reactor login', async () => {
        const mockClient = {
            reactions: {
                listForIssueComment: vi.fn().mockResolvedValue({
                    data: [
                        { content: '+1', user: { login: 'reporter-user' } },
                        { content: '-1', user: { login: 'someone-else' } },
                    ],
                }),
            },
        };

        const result = await listCommentReactions(mockClient as never, 'owner', 'repo', 12345);

        expect(result).toEqual([
            { content: '+1', login: 'reporter-user' },
            { content: '-1', login: 'someone-else' },
        ]);
        expect(mockClient.reactions.listForIssueComment).toHaveBeenCalledWith({
            owner: 'owner',
            repo: 'repo',
            comment_id: 12345,
            per_page: 100,
        });
    });
});

describe('isGithubNotFound', () => {
    it('is true only for an error carrying status 404', () => {
        expect(isGithubNotFound(Object.assign(new Error('Not Found'), { status: 404 }))).toBe(true);
        expect(isGithubNotFound(Object.assign(new Error('Server Error'), { status: 502 }))).toBe(
            false,
        );
        expect(isGithubNotFound(new Error('Not Found'))).toBe(false);
        expect(isGithubNotFound(null)).toBe(false);
        expect(isGithubNotFound('Not Found')).toBe(false);
    });
});

describe('isRepoVisible', () => {
    function clientWithRepoGet(get: GithubReactionClient['repos']['get']): GithubReactionClient {
        return { repos: { get }, reactions: { listForIssueComment: vi.fn() } };
    }

    it('is true when the repo can be read', async () => {
        const get = vi.fn<GithubReactionClient['repos']['get']>().mockResolvedValue({ data: {} });

        await expect(isRepoVisible(clientWithRepoGet(get), 'owner', 'repo')).resolves.toBe(true);
        expect(get).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo' });
    });

    it('is false when the repo itself 404s', async () => {
        const get = vi
            .fn<GithubReactionClient['repos']['get']>()
            .mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));

        await expect(isRepoVisible(clientWithRepoGet(get), 'owner', 'repo')).resolves.toBe(false);
    });

    it('rethrows any other failure', async () => {
        const get = vi
            .fn<GithubReactionClient['repos']['get']>()
            .mockRejectedValue(Object.assign(new Error('Bad credentials'), { status: 401 }));

        await expect(isRepoVisible(clientWithRepoGet(get), 'owner', 'repo')).rejects.toThrow(
            'Bad credentials',
        );
    });
});

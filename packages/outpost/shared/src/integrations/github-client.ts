/**
 * Minimal GitHub App client for the worker process — read-only access
 * to comment reactions, used by the GITHUB_REACTION_POLL job.
 *
 * Deliberately separate from apps/github-app/src/lib/github-client.ts,
 * which lives in a different process and handles posting. This module
 * only needs reaction reads, and the worker process has no other
 * Octokit access today.
 */

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

export interface GithubClientConfig {
    appId: string;
    privateKey: string;
    installationId: string;
}

/** Minimal interface for the Octokit calls this module needs. */
export interface GithubReactionClient {
    repos: {
        get(params: { owner: string; repo: string }): Promise<unknown>;
    };
    reactions: {
        listForIssueComment(params: {
            owner: string;
            repo: string;
            comment_id: number;
            per_page?: number;
        }): Promise<{ data: Array<{ content: string; user: { login: string } | null }> }>;
    };
}

export function createGithubClient(config: GithubClientConfig): GithubReactionClient {
    return new Octokit({
        authStrategy: createAppAuth,
        auth: {
            appId: config.appId,
            privateKey: config.privateKey,
            installationId: config.installationId,
        },
    }) as unknown as GithubReactionClient;
}

export interface CommentReaction {
    content: string;
    login: string;
}

/**
 * List reactions on a GitHub issue comment. Only works for issue comments
 * (numeric REST comment IDs) — discussion-comment reactions are addressed
 * by GraphQL node_ids, not numeric REST IDs, and require the GraphQL API,
 * which is out of scope for this client.
 */
export async function listCommentReactions(
    client: GithubReactionClient,
    owner: string,
    repo: string,
    commentId: number,
): Promise<CommentReaction[]> {
    const response = await client.reactions.listForIssueComment({
        owner,
        repo,
        comment_id: commentId,
        per_page: 100,
    });

    return response.data
        .filter((r) => r.user !== null)
        .map((r) => ({ content: r.content, login: r.user!.login }));
}

/**
 * True when an Octokit call failed with HTTP 404. Octokit's RequestError
 * carries the response status on `status`.
 */
export function isGithubNotFound(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { status?: unknown }).status === 404
    );
}

/**
 * Whether the App can see `owner/repo`. GitHub answers 404 both for a deleted
 * comment and for a repo the App cannot see; only the first means the comment
 * is gone for good, so callers check this before treating a comment 404 as a
 * deletion. A 404 on the repo returns false; any other failure propagates.
 */
export async function isRepoVisible(
    client: GithubReactionClient,
    owner: string,
    repo: string,
): Promise<boolean> {
    try {
        await client.repos.get({ owner, repo });
        return true;
    } catch (error) {
        if (isGithubNotFound(error)) return false;
        throw error;
    }
}

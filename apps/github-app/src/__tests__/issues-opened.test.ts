import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockPrisma, mockQueue } from './helpers/mocks.js';

// Mock dependencies before importing the handler
vi.mock('@copilotkit/outpost/db', () => mockPrisma());
vi.mock('@copilotkit/outpost/queue', () => mockQueue());

const mockHandleResult = {
    ticketId: 'ticket-internal-id',
    displayId: 'TKT-GH01',
    isNewTicket: true,
    isOrphanedReply: false,
    aiJobEnqueued: true,
    messageId: 'message-internal-id',
};

const mockHandle = vi.fn().mockResolvedValue(mockHandleResult);
const mockParseInboundEvent = vi.fn().mockReturnValue({
    kind: 'new_ticket',
    source: 'GITHUB_ISSUE',
    sourceId: 'CopilotKit/CopilotKit#42',
    sourceUrl: 'https://github.com/CopilotKit/CopilotKit/issues/42',
    channel: 'CopilotKit/CopilotKit',
    title: 'Bug: CopilotKit crashes on init',
    body: 'When I call useCopilotKit() in my Next.js app, it crashes.',
    author: 'user123 (999)',
    isBot: false,
    authorLogin: 'user123',
});
const mockPostSystemMessage = vi.fn().mockResolvedValue(undefined);
const mockPostResponse = vi.fn().mockResolvedValue(undefined);

vi.mock('@copilotkit/outpost/shared', () => ({
    generateTicketId: vi.fn().mockReturnValue('TKT-GH01'),
    truncate: vi.fn((str: string, _len: number) => str),
}));

vi.mock('@copilotkit/outpost/shared/platforms', () => ({
    InboundHandler: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        this.handle = mockHandle;
    }),
    GitHubPlatformAdapter: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        this.parseInboundEvent = mockParseInboundEvent;
        this.postSystemMessage = mockPostSystemMessage;
        this.postResponse = mockPostResponse;
        this.name = 'github';
    }),
}));

vi.mock('../lib/github-client.js', () => ({
    getOctokit: vi.fn().mockReturnValue({}),
    postIssueComment: vi.fn().mockResolvedValue(12345),
}));

vi.mock('../config.js', () => ({
    config: {
        appId: 'test-app-id',
        privateKey: 'test-private-key',
        installationId: 'test-installation-id',
        webhookSecret: 'test-secret',
        port: 3200,
        teamLogins: ['teambot'],
        allowedRepos: ['CopilotKit/CopilotKit'],
    },
}));

import { handleIssueOpened } from '../webhooks/issues-opened.js';
import { prisma } from '@copilotkit/outpost/db';
import { InboundHandler, GitHubPlatformAdapter } from '@copilotkit/outpost/shared/platforms';
import type { EmitterWebhookEvent } from '@octokit/webhooks';

function makeEvent(overrides: Record<string, unknown> = {}): EmitterWebhookEvent<'issues.opened'> {
    return {
        id: 'evt-1',
        name: 'issues',
        payload: {
            action: 'opened',
            issue: {
                number: 42,
                title: 'Bug: CopilotKit crashes on init',
                body: 'When I call useCopilotKit() in my Next.js app, it crashes.',
                html_url: 'https://github.com/CopilotKit/CopilotKit/issues/42',
                ...((overrides.issue as Record<string, unknown>) ?? {}),
            },
            repository: {
                full_name: 'CopilotKit/CopilotKit',
                ...((overrides.repository as Record<string, unknown>) ?? {}),
            },
            sender: {
                login: 'user123',
                id: 999,
                type: 'User',
                ...((overrides.sender as Record<string, unknown>) ?? {}),
            },
            ...overrides,
        },
    } as unknown as EmitterWebhookEvent<'issues.opened'>;
}

describe('handleIssueOpened', () => {
    beforeEach(() => {
        vi.mocked(prisma.ticketExternalLink.create).mockResolvedValue({
            id: 'link-1',
            ticketId: 'ticket-internal-id',
            plugin: 'github',
            externalId: 'CopilotKit/CopilotKit#42',
        } as ReturnType<typeof prisma.ticketExternalLink.create> extends Promise<infer T>
            ? T
            : never);
    });

    it('uses GitHubPlatformAdapter to parse the event', async () => {
        const event = makeEvent();
        await handleIssueOpened(event);

        expect(GitHubPlatformAdapter).toHaveBeenCalled();
        expect(mockParseInboundEvent).toHaveBeenCalledWith({
            action: 'opened',
            issue: event.payload.issue,
            repository: event.payload.repository,
            sender: event.payload.sender,
        });
    });

    it('uses InboundHandler to create ticket and enqueue AI job', async () => {
        const event = makeEvent();
        await handleIssueOpened(event);

        expect(InboundHandler).toHaveBeenCalled();
        expect(mockHandle).toHaveBeenCalled();
    });

    it('creates TicketExternalLink for bidirectional sync', async () => {
        const event = makeEvent();
        await handleIssueOpened(event);

        expect(prisma.ticketExternalLink.create).toHaveBeenCalledWith({
            data: {
                ticketId: 'ticket-internal-id',
                plugin: 'github',
                externalId: 'CopilotKit/CopilotKit#42',
                externalUrl: 'https://github.com/CopilotKit/CopilotKit/issues/42',
            },
        });
    });

    it('does not post a ticket-created acknowledgment comment on the issue', async () => {
        const event = makeEvent();
        await handleIssueOpened(event);

        // The internal ticket id is noise on a public issue — the AI response is
        // the bot's only comment in the thread.
        expect(mockPostSystemMessage).not.toHaveBeenCalled();
    });

    it('handles parse failure gracefully', async () => {
        mockParseInboundEvent.mockReturnValueOnce(null);

        const event = makeEvent();
        await handleIssueOpened(event);

        // Should not create external link or call InboundHandler
        expect(prisma.ticketExternalLink.create).not.toHaveBeenCalled();
        expect(mockHandle).not.toHaveBeenCalled();
    });

    it('ignores issues on non-allowlisted repos (e.g. CopilotKit/outpost)', async () => {
        const event = makeEvent({ repository: { full_name: 'CopilotKit/outpost' } });
        await handleIssueOpened(event);

        // No ticket created, no acknowledgment posted
        expect(mockHandle).not.toHaveBeenCalled();
        expect(prisma.ticketExternalLink.create).not.toHaveBeenCalled();
        expect(mockPostSystemMessage).not.toHaveBeenCalled();
    });

    // The gate has to sit HERE, before the ticket exists. Creating the ticket is
    // what enqueues the AI job, and that job is what forwards the body verbatim
    // into search-docs/search-code on mcp.copilotkit.ai and posts a public
    // reply. A filter further down would still have paid for the relay.
    it('ignores a link-spam issue without creating a ticket or relaying anything', async () => {
        const event = makeEvent({
            issue: {
                body:
                    Array.from(
                        { length: 8 },
                        (_, i) => `Read [our SEO guide ${i}](https://1rank.app/g-${i}). `,
                    ).join('') + 'Search visibility wins customers. '.repeat(100),
                author_association: 'NONE',
            },
        });

        await handleIssueOpened(event);

        expect(mockParseInboundEvent).not.toHaveBeenCalled();
        expect(mockHandle).not.toHaveBeenCalled();
        expect(prisma.ticketExternalLink.create).not.toHaveBeenCalled();
        expect(mockPostResponse).not.toHaveBeenCalled();
    });

    // The other half of the same guarantee: a long, link-carrying bug report
    // from a first-time reporter still gets answered.
    it('still relays a long bug report from an untrusted author', async () => {
        const event = makeEvent({
            issue: {
                body: [
                    'Repro: https://github.com/someone/repro',
                    'Docs: https://docs.copilotkit.ai/quickstart',
                    '```ts',
                    'useCopilotAction({ name: "x" });',
                    '```',
                    'Stack trace follows. '.repeat(200),
                ].join('\n'),
                author_association: 'NONE',
            },
        });

        await handleIssueOpened(event);

        expect(mockHandle).toHaveBeenCalled();
        expect(prisma.ticketExternalLink.create).toHaveBeenCalled();
    });
});

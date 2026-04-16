import { describe, it, expect, vi } from 'vitest';

vi.mock('@outpost/db', () => ({
    prisma: {
        ticket: {
            findFirst: vi.fn(),
        },
        user: {
            findFirst: vi.fn(),
        },
        teamMember: {
            findUnique: vi.fn(),
        },
    },
}));

import { findTicketByThreadTs, isTeamMember, buildPermalink } from '../lib/tickets.js';
import { prisma } from '@outpost/db';

describe('findTicketByThreadTs', () => {
    it('queries by composite sourceId of channelId:threadTs', async () => {
        vi.mocked(prisma.ticket.findFirst).mockResolvedValue(null);

        await findTicketByThreadTs('C_CHAN', '1234567890.123456');

        expect(prisma.ticket.findFirst).toHaveBeenCalledWith({
            where: {
                source: 'SLACK',
                sourceId: 'C_CHAN:1234567890.123456',
            },
        });
    });

    it('returns the ticket when found', async () => {
        const ticket = { id: 'ticket-1', displayId: 'TKT-0001' };
        vi.mocked(prisma.ticket.findFirst).mockResolvedValue(
            ticket as ReturnType<typeof prisma.ticket.findFirst> extends Promise<infer T> ? T : never,
        );

        const result = await findTicketByThreadTs('C_CHAN', '1234567890.123456');
        expect(result).toEqual(ticket);
    });

    it('returns null when no ticket found', async () => {
        vi.mocked(prisma.ticket.findFirst).mockResolvedValue(null);

        const result = await findTicketByThreadTs('C_CHAN', '9999999999.000000');
        expect(result).toBeNull();
    });
});

describe('isTeamMember', () => {
    it('returns true when user has a matching TeamMember record', async () => {
        vi.mocked(prisma.user.findFirst).mockResolvedValue({
            id: 'u-1',
            email: 'team@copilotkit.ai',
        } as ReturnType<typeof prisma.user.findFirst> extends Promise<infer T> ? T : never);

        vi.mocked(prisma.teamMember.findUnique).mockResolvedValue({
            id: 'tm-1',
        } as ReturnType<typeof prisma.teamMember.findUnique> extends Promise<infer T> ? T : never);

        const result = await isTeamMember('U_TEAM');

        expect(prisma.user.findFirst).toHaveBeenCalledWith({
            where: { externalId: 'U_TEAM', source: 'SLACK' },
        });
        expect(result).toBe(true);
    });

    it('returns false when no User record found', async () => {
        vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

        const result = await isTeamMember('U_UNKNOWN');
        expect(result).toBe(false);
    });

    it('returns false when User has no email', async () => {
        vi.mocked(prisma.user.findFirst).mockResolvedValue({
            id: 'u-1',
            email: null,
        } as unknown as ReturnType<typeof prisma.user.findFirst> extends Promise<infer T> ? T : never);

        const result = await isTeamMember('U_NO_EMAIL');
        expect(result).toBe(false);
    });

    it('returns false when User email does not match a TeamMember', async () => {
        vi.mocked(prisma.user.findFirst).mockResolvedValue({
            id: 'u-1',
            email: 'external@company.com',
        } as ReturnType<typeof prisma.user.findFirst> extends Promise<infer T> ? T : never);

        vi.mocked(prisma.teamMember.findUnique).mockResolvedValue(null);

        const result = await isTeamMember('U_EXTERNAL');
        expect(result).toBe(false);
    });
});

describe('buildPermalink', () => {
    it('builds a valid Slack permalink URL', () => {
        const url = buildPermalink('C12345', '1234567890.123456');
        expect(url).toBe('https://slack.com/archives/C12345/p1234567890123456');
    });

    it('handles timestamps without dots', () => {
        const url = buildPermalink('C12345', '1234567890123456');
        expect(url).toBe('https://slack.com/archives/C12345/p1234567890123456');
    });
});

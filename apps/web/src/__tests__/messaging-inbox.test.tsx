import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageInbox } from '@/components/messaging/message-inbox';
import {
    type PendingMessage,
    MessageSource,
    MessageStatus,
} from '@outpost/shared';

// Mock next/navigation
vi.mock('next/navigation', () => ({
    usePathname: () => '/messaging',
    useRouter: () => ({ push: vi.fn() }),
}));

function hoursAgo(hours: number): string {
    return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

const mockMessages: PendingMessage[] = [
    {
        id: 'msg-1',
        customerName: 'Alice Smith',
        accountId: 'acc-alpha',
        accountName: 'Alpha Corp',
        accountAcv: 200000,
        source: MessageSource.SLACK,
        channelName: '#alpha-support',
        messagePreview: 'Need help with integration',
        receivedAt: hoursAgo(5),
        status: MessageStatus.UNANSWERED,
    },
    {
        id: 'msg-2',
        customerName: 'Bob Jones',
        accountId: 'acc-beta',
        accountName: 'Beta Inc',
        accountAcv: 100000,
        source: MessageSource.TEAMS,
        channelName: 'Beta Support',
        messagePreview: 'Quick question about pricing',
        receivedAt: hoursAgo(0.5),
        status: MessageStatus.UNANSWERED,
    },
    {
        id: 'msg-3',
        customerName: 'Carol White',
        accountId: 'acc-gamma',
        accountName: 'Gamma Ltd',
        accountAcv: 300000,
        source: MessageSource.SLACK,
        channelName: '#gamma-channel',
        messagePreview: 'Thanks for the update',
        receivedAt: hoursAgo(2),
        status: MessageStatus.ANSWERED,
        answeredAt: hoursAgo(1.5),
    },
];

describe('MessageInbox', () => {
    it('renders the page header', () => {
        render(<MessageInbox messages={mockMessages} />);
        expect(screen.getByText('Messages')).toBeInTheDocument();
    });

    it('renders all message cards', () => {
        render(<MessageInbox messages={mockMessages} />);
        const cards = screen.getAllByTestId('message-card');
        expect(cards).toHaveLength(3);
    });

    it('shows customer names', () => {
        render(<MessageInbox messages={mockMessages} />);
        expect(screen.getByText('Alice Smith')).toBeInTheDocument();
        expect(screen.getByText('Bob Jones')).toBeInTheDocument();
        expect(screen.getByText('Carol White')).toBeInTheDocument();
    });

    it('shows unanswered and total counts', () => {
        render(<MessageInbox messages={mockMessages} />);
        expect(screen.getByText('2')).toBeInTheDocument(); // unanswered count
        expect(screen.getByText('3')).toBeInTheDocument(); // total count
    });

    it('shows overdue count for messages > 4h', () => {
        render(<MessageInbox messages={mockMessages} />);
        expect(screen.getByText(/overdue/i)).toBeInTheDocument();
    });

    it('shows source icons for Slack and Teams', () => {
        render(<MessageInbox messages={mockMessages} />);
        expect(screen.getAllByTestId('source-slack')).toHaveLength(2);
        expect(screen.getAllByTestId('source-teams')).toHaveLength(1);
    });

    it('renders urgency badges for unanswered messages', () => {
        render(<MessageInbox messages={mockMessages} />);
        const badges = screen.getAllByTestId('urgency-badge');
        // Only unanswered messages get urgency badges
        expect(badges.length).toBe(2);
    });

    it('shows HIGH urgency for the 5h old message', () => {
        render(<MessageInbox messages={mockMessages} />);
        const badges = screen.getAllByTestId('urgency-badge');
        const highBadge = badges.find((b) => b.getAttribute('data-urgency') === 'HIGH');
        expect(highBadge).toBeTruthy();
    });

    it('renders filter controls', () => {
        render(<MessageInbox messages={mockMessages} />);
        expect(screen.getByTestId('message-filters')).toBeInTheDocument();
        expect(screen.getByTestId('filter-source')).toBeInTheDocument();
        expect(screen.getByTestId('filter-status')).toBeInTheDocument();
        expect(screen.getByTestId('filter-account')).toBeInTheDocument();
        expect(screen.getByTestId('sort-select')).toBeInTheDocument();
    });

    it('filters by source (Slack only)', () => {
        render(<MessageInbox messages={mockMessages} />);
        const sourceSelect = screen.getByTestId('filter-source');
        fireEvent.change(sourceSelect, { target: { value: 'SLACK' } });
        const cards = screen.getAllByTestId('message-card');
        expect(cards).toHaveLength(2); // Alice (Slack) + Carol (Slack)
    });

    it('filters by status (Unanswered only)', () => {
        render(<MessageInbox messages={mockMessages} />);
        const statusSelect = screen.getByTestId('filter-status');
        fireEvent.change(statusSelect, { target: { value: 'UNANSWERED' } });
        const cards = screen.getAllByTestId('message-card');
        expect(cards).toHaveLength(2);
    });

    it('filters by account', () => {
        render(<MessageInbox messages={mockMessages} />);
        const accountSelect = screen.getByTestId('filter-account');
        fireEvent.change(accountSelect, { target: { value: 'acc-alpha' } });
        const cards = screen.getAllByTestId('message-card');
        expect(cards).toHaveLength(1);
        expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    });

    it('sorts by ACV (highest first)', () => {
        render(<MessageInbox messages={mockMessages} />);
        const sortSelect = screen.getByTestId('sort-select');
        fireEvent.change(sortSelect, { target: { value: 'acv' } });
        const cards = screen.getAllByTestId('message-card');
        // Gamma (300k) > Alpha (200k) > Beta (100k)
        const names = cards.map((c) => {
            const nameEl = c.querySelector('.font-semibold');
            return nameEl?.textContent;
        });
        expect(names).toEqual(['Carol White', 'Alice Smith', 'Bob Jones']);
    });

    it('shows empty state when filters match nothing', () => {
        render(<MessageInbox messages={mockMessages} />);
        // Filter to Teams + Answered = no results (Carol is Slack, Tom is Teams+Answered but not in mock)
        const sourceSelect = screen.getByTestId('filter-source');
        fireEvent.change(sourceSelect, { target: { value: 'TEAMS' } });
        const statusSelect = screen.getByTestId('filter-status');
        fireEvent.change(statusSelect, { target: { value: 'ANSWERED' } });
        expect(screen.getByText(/no messages match/i)).toBeInTheDocument();
    });
});

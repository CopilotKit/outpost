import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfidenceBadge } from '@/components/qa/confidence-badge';
import { CopyButton } from '@/components/qa/copy-button';
import { ChatInput } from '@/components/qa/chat-input';
import { ChatMessage } from '@/components/qa/chat-message';
import type { ChatMessageData } from '@/components/qa/chat-message';
import { SourcePanel } from '@/components/qa/source-panel';

// Mock clipboard API
const mockWriteText = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, {
    clipboard: { writeText: mockWriteText },
});

describe('ConfidenceBadge', () => {
    it('renders HIGH confidence with green styling', () => {
        render(<ConfidenceBadge level="HIGH" />);
        const badge = screen.getByTestId('confidence-badge');
        expect(badge).toHaveTextContent('High confidence');
        expect(badge.dataset.level).toBe('HIGH');
        expect(badge.className).toContain('text-green-400');
    });

    it('renders MEDIUM confidence with yellow styling', () => {
        render(<ConfidenceBadge level="MEDIUM" />);
        const badge = screen.getByTestId('confidence-badge');
        expect(badge).toHaveTextContent('Medium confidence');
        expect(badge.className).toContain('text-yellow-400');
    });

    it('renders LOW confidence with red styling', () => {
        render(<ConfidenceBadge level="LOW" />);
        const badge = screen.getByTestId('confidence-badge');
        expect(badge).toHaveTextContent('Low confidence');
        expect(badge.className).toContain('text-red-400');
    });
});

describe('CopyButton', () => {
    beforeEach(() => {
        mockWriteText.mockClear();
    });

    it('copies text to clipboard on click', async () => {
        render(<CopyButton text="Hello world" />);
        const button = screen.getByTestId('copy-button');
        fireEvent.click(button);

        await waitFor(() => {
            expect(mockWriteText).toHaveBeenCalledWith('Hello world');
        });
    });

    it('shows Copied! after clicking', async () => {
        render(<CopyButton text="Test text" />);
        const button = screen.getByTestId('copy-button');
        fireEvent.click(button);

        await waitFor(() => {
            expect(screen.getByText('Copied!')).toBeInTheDocument();
        });
    });
});

describe('ChatInput', () => {
    it('renders textarea and send button', () => {
        const onSend = vi.fn();
        render(<ChatInput onSend={onSend} />);

        expect(screen.getByTestId('chat-input-textarea')).toBeInTheDocument();
        expect(screen.getByTestId('chat-send-button')).toBeInTheDocument();
    });

    it('submits on Enter key', () => {
        const onSend = vi.fn();
        render(<ChatInput onSend={onSend} />);

        const textarea = screen.getByTestId('chat-input-textarea');
        fireEvent.change(textarea, { target: { value: 'How do I use CopilotKit?' } });
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

        expect(onSend).toHaveBeenCalledWith('How do I use CopilotKit?');
    });

    it('does not submit on Shift+Enter', () => {
        const onSend = vi.fn();
        render(<ChatInput onSend={onSend} />);

        const textarea = screen.getByTestId('chat-input-textarea');
        fireEvent.change(textarea, { target: { value: 'test' } });
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

        expect(onSend).not.toHaveBeenCalled();
    });

    it('does not submit empty messages', () => {
        const onSend = vi.fn();
        render(<ChatInput onSend={onSend} />);

        const textarea = screen.getByTestId('chat-input-textarea');
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

        expect(onSend).not.toHaveBeenCalled();
    });

    it('clears input after submission', () => {
        const onSend = vi.fn();
        render(<ChatInput onSend={onSend} />);

        const textarea = screen.getByTestId('chat-input-textarea') as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: 'test message' } });
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

        expect(textarea.value).toBe('');
    });

    it('disables input when disabled prop is true', () => {
        const onSend = vi.fn();
        render(<ChatInput onSend={onSend} disabled />);

        const textarea = screen.getByTestId('chat-input-textarea');
        expect(textarea).toBeDisabled();
    });
});

describe('ChatMessage', () => {
    it('renders user message correctly', () => {
        const message: ChatMessageData = {
            id: 'msg-1',
            role: 'user',
            content: 'What is CopilotKit?',
        };
        render(<ChatMessage message={message} />);

        expect(screen.getByTestId('chat-message-user')).toBeInTheDocument();
        expect(screen.getByText('You')).toBeInTheDocument();
        expect(screen.getByText('What is CopilotKit?')).toBeInTheDocument();
    });

    it('renders AI message with confidence badge', () => {
        const message: ChatMessageData = {
            id: 'msg-2',
            role: 'assistant',
            content: 'CopilotKit is a framework.',
            confidence: 'HIGH',
        };
        render(<ChatMessage message={message} />);

        expect(screen.getByTestId('chat-message-assistant')).toBeInTheDocument();
        expect(screen.getByText('Outpost AI')).toBeInTheDocument();
        expect(screen.getByTestId('confidence-badge')).toBeInTheDocument();
    });

    it('renders copy button for completed AI messages', () => {
        const message: ChatMessageData = {
            id: 'msg-3',
            role: 'assistant',
            content: 'Here is the answer.',
            confidence: 'HIGH',
        };
        render(<ChatMessage message={message} />);

        expect(screen.getByText('Copy response')).toBeInTheDocument();
    });

    it('does not render copy button while streaming', () => {
        const message: ChatMessageData = {
            id: 'msg-4',
            role: 'assistant',
            content: 'Generating...',
            streaming: true,
        };
        render(<ChatMessage message={message} />);

        expect(screen.queryByText('Copy response')).not.toBeInTheDocument();
    });

    it('renders AI message content as markdown', () => {
        const message: ChatMessageData = {
            id: 'msg-5',
            role: 'assistant',
            content: '**Bold text** and `inline code`',
        };
        render(<ChatMessage message={message} />);

        // Bold text should be in a strong tag
        const strong = screen.getByText('Bold text');
        expect(strong.tagName).toBe('STRONG');
    });
});

describe('SourcePanel', () => {
    it('renders nothing when sources are empty', () => {
        const { container } = render(<SourcePanel sources={[]} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders source count', () => {
        const sources = [
            { title: 'Doc 1', content: 'Some content', score: 0.9 },
            { title: 'Doc 2', content: 'More content', score: 0.7 },
        ];
        render(<SourcePanel sources={sources} />);

        expect(screen.getByText('2 sources')).toBeInTheDocument();
    });

    it('expands to show source details on click', () => {
        const sources = [
            { title: 'Getting Started', content: 'Install CopilotKit...', score: 0.85 },
        ];
        render(<SourcePanel sources={sources} />);

        // Should show count but not content initially
        expect(screen.getByText('1 source')).toBeInTheDocument();
        expect(screen.queryByText('Getting Started')).not.toBeInTheDocument();

        // Click to expand
        fireEvent.click(screen.getByText('1 source'));

        // Now source details should be visible
        expect(screen.getByText('Getting Started')).toBeInTheDocument();
        expect(screen.getByText('85% relevant')).toBeInTheDocument();
    });
});

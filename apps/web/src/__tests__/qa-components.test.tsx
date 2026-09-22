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
    it('keeps technical details in a collapsed native disclosure', () => {
        const { container } = render(
            <ChatMessage
                message={{
                    id: 'structured',
                    role: 'assistant',
                    content: 'Use the supported tool hook.',
                    details: 'Verified **technical details**.',
                }}
            />,
        );
        expect(screen.getByText('Use the supported tool hook.')).toBeInTheDocument();
        expect(screen.getByText('Technical details and sources')).toBeInTheDocument();
        expect(container.querySelector('details')).not.toHaveAttribute('open');
        expect(container.querySelector('details strong')).toHaveTextContent('technical details');
    });

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

    // The support-reply validator in packages/outpost/ai only grounds a reply
    // against the links this configuration actually publishes. These rows record
    // that published set for the link spellings it reasons about, so a renderer or
    // remark-gfm change that moves a destination fails here rather than quietly
    // widening what an unvalidated reply can link to. Kept as literal fixtures so
    // the web suite stays independent of the AI package's tests.
    it.each([
        { markdown: 'Contact help@example.invalid now.', hrefs: ['mailto:help@example.invalid'] },
        {
            markdown: 'Contact mailto:help@example.invalid now.',
            hrefs: ['mailto:help@example.invalid'],
        },
        {
            markdown: 'Contact xmpp:help@example.invalid now.',
            hrefs: ['mailto:help@example.invalid'],
        },
        {
            markdown: 'See www.copilotkit.ai/reference/provider for the option.',
            hrefs: ['http://www.copilotkit.ai/reference/provider'],
        },
        {
            markdown: 'Read https://docs.copilotkit.ai/reference/setup).',
            hrefs: ['https://docs.copilotkit.ai/reference/setup'],
        },
        {
            markdown: 'Read <https://docs.copilotkit.ai/reference/setup)>.',
            hrefs: ['https://docs.copilotkit.ai/reference/setup)'],
        },
        {
            markdown: 'Read [Doc](https://docs.copilotkit.ai/reference/provider).',
            hrefs: ['https://docs.copilotkit.ai/reference/provider'],
        },
        {
            markdown: 'Read [Doc][g].\n\n[g]: https://docs.copilotkit.ai/reference/provider',
            hrefs: ['https://docs.copilotkit.ai/reference/provider'],
        },
        // Inert under this configuration: no anchor is published at all.
        { markdown: 'Use ftp://example.invalid/pub for the archive.', hrefs: [] },
        { markdown: 'Contact `help@example.invalid` now.', hrefs: [] },
        { markdown: '```text\nhelp@example.invalid\n```', hrefs: [] },
    ])('publishes the recorded link destinations for $markdown', ({ markdown, hrefs }) => {
        const { container } = render(
            <ChatMessage message={{ id: 'link-fixture', role: 'assistant', content: markdown }} />,
        );

        expect(
            [...container.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href')),
        ).toEqual(hrefs);
    });

    // The same validator refuses to read code as prose, and a fence opens wherever
    // its container's content starts rather than at column three. These rows record
    // that this configuration publishes each of them as a code block whose body is
    // inert: the JSX arrives as text rather than as a mounted element, and neither
    // the bare address nor the `www.` host GFM linkifies elsewhere becomes a link.
    // A renderer or remark-gfm change that starts publishing any of this fails here
    // instead of quietly widening what an accepted reply can emit. Literal fixtures,
    // so the web suite stays independent of the AI package's tests.
    it.each([
        {
            markdown:
                '- Example:\n\n    ```tsx\n    <CopilotKit runtimeUrl="/api/copilotkit" />\n    ```',
            code: '<CopilotKit runtimeUrl="/api/copilotkit" />\n',
        },
        {
            markdown: '> ```tsx\n> <CopilotKit runtimeUrl="/api/copilotkit" />\n> ```',
            code: '<CopilotKit runtimeUrl="/api/copilotkit" />\n',
        },
        {
            markdown:
                '10. Example:\n\n    ```text\n    https://example.invalid/documented-example\n    ```',
            code: 'https://example.invalid/documented-example\n',
        },
        {
            markdown: '> > ```tsx\n> > <Provider />\n> > ```',
            code: '<Provider />\n',
        },
        // No fence: four columns past the item's content column is indented code.
        {
            markdown: '- Example:\n\n      https://example.invalid/documented-example',
            code: 'https://example.invalid/documented-example\n',
        },
        {
            markdown: '> ```text\n> www.example.invalid/steal\n> ```',
            code: 'www.example.invalid/steal\n',
        },
        {
            markdown: '- Example:\n\n    ```text\n    help@example.invalid\n    ```',
            code: 'help@example.invalid\n',
        },
    ])('publishes $markdown as inert code', ({ markdown, code }) => {
        const { container } = render(
            <ChatMessage message={{ id: 'code-fixture', role: 'assistant', content: markdown }} />,
        );

        expect([...container.querySelectorAll('pre code')].map((node) => node.textContent)).toEqual(
            [code],
        );
        expect(container.querySelectorAll('a')).toHaveLength(0);
        expect(container.querySelector('copilotkit, provider')).toBeNull();
    });

    // What the validator's unclosed-fence refusal protects: the footer
    // supportReplyDetails appends to `details`. A top-level fence left open
    // swallows it into the code block; a fence a block container carries does not,
    // because the blank line closes the container first.
    it.each([
        { markdown: '```tsx\n<Provider />', swallowed: true },
        { markdown: '> ```tsx\n> <Provider />', swallowed: false },
        { markdown: '- Example:\n\n    ```tsx\n    <Provider />', swallowed: false },
    ])('swallows the appended footer for $markdown: $swallowed', ({ markdown, swallowed }) => {
        const { container } = render(
            <ChatMessage
                message={{
                    id: 'footer-fixture',
                    role: 'assistant',
                    content: `${markdown}\n\n**API version:** v2`,
                }}
            />,
        );

        expect(container.querySelector('pre code')?.textContent).toContain('<Provider />');
        expect(container.querySelector('strong')?.textContent ?? null).toEqual(
            swallowed ? null : 'API version:',
        );
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

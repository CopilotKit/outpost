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
        // A scheme-less `www.` host is linkified in whatever case it was written, and
        // the scheme prepended to it is http:// in every one of them. A host is
        // case-insensitive, so each of these hrefs resolves to the lowercase row
        // above — which is why the validator grounds all four on one evidence URL,
        // and why it has to prepend that same scheme for a capitalized prefix too. A
        // renderer or remark-gfm change that stops linkifying one of these spellings,
        // or that normalizes the host it publishes, fails here.
        {
            markdown: 'See WWW.copilotkit.ai/reference/provider for the option.',
            hrefs: ['http://WWW.copilotkit.ai/reference/provider'],
        },
        {
            markdown: 'See Www.copilotkit.ai/reference/provider for the option.',
            hrefs: ['http://Www.copilotkit.ai/reference/provider'],
        },
        {
            markdown: 'See wWw.copilotkit.ai/reference/provider for the option.',
            hrefs: ['http://wWw.copilotkit.ai/reference/provider'],
        },
        // The same spellings carry an ungrounded host just as clickably, which is why
        // the validator still refuses those.
        {
            markdown: 'See WWW.example.invalid/steal for the option.',
            hrefs: ['http://WWW.example.invalid/steal'],
        },
        {
            markdown: 'Read https://docs.copilotkit.ai/reference/setup).',
            hrefs: ['https://docs.copilotkit.ai/reference/setup'],
        },
        {
            markdown: 'Read <https://docs.copilotkit.ai/reference/setup)>.',
            hrefs: ['https://docs.copilotkit.ai/reference/setup)'],
        },
        // An autolink's address is published exactly as written, and `'` and '`' are
        // both ordinary URL content an evidence URL may hold. Each href below is the
        // `new URL(address)` canonicalization of the address — `'` survives it, '`'
        // percent-encodes to %60 — which is what lets the validator ground a reply on
        // one of these rather than on the prefix a character class would read. A
        // renderer or remark-gfm change that publishes either differently fails here.
        {
            markdown: "Read <https://docs.copilotkit.ai/reference/provider's>.",
            hrefs: ["https://docs.copilotkit.ai/reference/provider's"],
        },
        {
            markdown: 'Read <https://docs.copilotkit.ai/reference/provider`name>.',
            hrefs: ['https://docs.copilotkit.ai/reference/provider%60name'],
        },
        {
            markdown: 'Read [Doc](https://docs.copilotkit.ai/reference/provider).',
            hrefs: ['https://docs.copilotkit.ai/reference/provider'],
        },
        {
            markdown: 'Read [Doc][g].\n\n[g]: https://docs.copilotkit.ai/reference/provider',
            hrefs: ['https://docs.copilotkit.ai/reference/provider'],
        },
        // An HTML character reference in a destination is resolved for an inline
        // link and a reference definition, and left exactly as spelled for either
        // autolink form. The validator compares each syntax against its own row
        // here, so a renderer change that aligns or further splits them fails here.
        {
            markdown: 'See [Doc](https://docs.copilotkit.ai/search?a=1&amp;b=2).',
            hrefs: ['https://docs.copilotkit.ai/search?a=1&b=2'],
        },
        {
            markdown: 'See [Doc][g].\n\n[g]: https://docs.copilotkit.ai/search?a=1&amp;b=2',
            hrefs: ['https://docs.copilotkit.ai/search?a=1&b=2'],
        },
        {
            markdown: 'See <https://docs.copilotkit.ai/search?a=1&amp;b=2> now.',
            hrefs: ['https://docs.copilotkit.ai/search?a=1&amp;b=2'],
        },
        {
            markdown: 'See https://docs.copilotkit.ai/search?a=1&amp;b=2 now.',
            hrefs: ['https://docs.copilotkit.ai/search?a=1&amp;b=2'],
        },
        // An emphasis or strikethrough run closing on a bare address is a delimiter,
        // not part of the address: the anchor carries the address alone and the run
        // is published outside it. The validator grounds a reply on these hrefs, so a
        // renderer or remark-gfm change that starts folding a delimiter into the
        // destination fails here rather than silently discarding a grounded reply.
        {
            markdown: '**Read https://docs.copilotkit.ai/reference/provider**',
            hrefs: ['https://docs.copilotkit.ai/reference/provider'],
        },
        {
            markdown: '*Read https://docs.copilotkit.ai/reference/provider*',
            hrefs: ['https://docs.copilotkit.ai/reference/provider'],
        },
        {
            markdown: '_Read https://docs.copilotkit.ai/reference/provider_',
            hrefs: ['https://docs.copilotkit.ai/reference/provider'],
        },
        {
            markdown: '__Read https://docs.copilotkit.ai/reference/provider__',
            hrefs: ['https://docs.copilotkit.ai/reference/provider'],
        },
        {
            markdown: '~~Read https://docs.copilotkit.ai/reference/provider~~',
            hrefs: ['https://docs.copilotkit.ai/reference/provider'],
        },
        {
            markdown: 'Read https://docs.copilotkit.ai/reference/provider*',
            hrefs: ['https://docs.copilotkit.ai/reference/provider'],
        },
        {
            markdown: '**https://docs.copilotkit.ai/reference/provider**',
            hrefs: ['https://docs.copilotkit.ai/reference/provider'],
        },
        // The same delimiters carry an ungrounded address just as clickably, which
        // is why the validator still has to refuse that spelling.
        {
            markdown: '**Read www.example.invalid/steal**',
            hrefs: ['http://www.example.invalid/steal'],
        },
        {
            markdown: '~~Contact help@example.invalid~~',
            hrefs: ['mailto:help@example.invalid'],
        },
        // An angle bracket the grammar closes no tag around does not stop GFM
        // linkifying the address beside it, so this is the published anchor the
        // validator refuses — the contrast to the same sentence with the address
        // inside a code span, which publishes none.
        {
            markdown: 'Compare <b, https://example.invalid/steal, and c> here.',
            hrefs: ['https://example.invalid/steal'],
        },
        // A bracket pair is a link only where a label closed on it. The subscript
        // row is the one that matters: it looks like the punctuation rows above it
        // and publishes a real anchor, so neither can be decided by the `](` alone.
        { markdown: 'Array access arr[i](x) in pseudocode.', hrefs: ['x'] },
        {
            markdown: '[![alt](https://cdn.example.invalid/a.png)](https://docs.example.invalid)',
            hrefs: ['https://docs.example.invalid'],
        },
        {
            // No label opened this one, but GFM still linkifies the bare URL in it.
            markdown: 'A stray ](https://docs.example.invalid) after nothing.',
            hrefs: ['https://docs.example.invalid'],
        },
        // A backtick run is a code span everywhere except inside a destination, so
        // this one is not code: an anchor is published, and the href it carries is
        // whatever the destination spells.
        { markdown: '[guide](`https://example.invalid/steal`)', hrefs: [''] },
        // Inert under this configuration: no anchor is published at all.
        {
            markdown: 'The literal punctuation ](not a link) is part of this sentence.',
            hrefs: [],
        },
        { markdown: 'Compare a](b) and c](d) in one line.', hrefs: [] },
        // The same backtick run as the `[guide]` row, with no label to open the
        // bracket, so it stays code and the address in it is text, not a link.
        { markdown: 'See ](`https://example.invalid/steal`) here.', hrefs: [] },
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

    // Three backticks are not always a fence. A run of three or more that closes on
    // the same line is a code span, which this configuration publishes inline as
    // <code> inside a paragraph rather than as a <pre><code> block — and whose body
    // is just as inert: the JSX arrives as text, and neither the bare address nor
    // the `www.` host GFM linkifies in prose becomes a link. The validator accepts
    // these rows on the strength of that; a renderer or remark-gfm change that turns
    // one of them into a block, an element or a link fails here rather than quietly
    // widening what an accepted reply can emit. Literal fixtures, so the web suite
    // stays independent of the AI package's tests.
    it.each([
        { markdown: '```literal code```', code: 'literal code' },
        {
            markdown: 'Run ```https://example.invalid/steal``` locally.',
            code: 'https://example.invalid/steal',
        },
        {
            markdown: 'Render ```<script>alert(1)</script>``` verbatim.',
            code: '<script>alert(1)</script>',
        },
        { markdown: 'Mail ```help@example.invalid``` please.', code: 'help@example.invalid' },
        {
            markdown: 'Host ```www.example.invalid/steal``` only.',
            code: 'www.example.invalid/steal',
        },
        { markdown: '```a `b` c```', code: 'a `b` c' },
        { markdown: '````literal code````', code: 'literal code' },
        // Four backticks is how a fence itself is quoted inline.
        { markdown: '```` ```tsx ````', code: '```tsx' },
        // Up to three leading spaces is still a paragraph, so still a span.
        { markdown: '   ```literal code```', code: 'literal code' },
    ])('publishes $markdown as an inline code span', ({ markdown, code }) => {
        const { container } = render(
            <ChatMessage message={{ id: 'span-fixture', role: 'assistant', content: markdown }} />,
        );

        const spans = [...container.querySelectorAll('p > code')];
        expect(spans.map((node) => node.textContent)).toEqual([code]);
        expect(container.querySelectorAll('pre')).toHaveLength(0);
        expect(container.querySelectorAll('a')).toHaveLength(0);
        expect(container.querySelector('script, provider')).toBeNull();
    });

    // Nor does a span have to close on the line that opened it. Each row below is
    // published as one inline <code> inside a single paragraph — no <pre>, no fence —
    // even though its second line begins with a run of three backticks, which is the
    // spelling a support answer uses to quote what a fenced example looks like. The
    // validator reads those lines as the span's content or its closing run on the
    // strength of this; a renderer or remark-gfm change that starts publishing one of
    // them as a block, an element or a link fails here rather than quietly widening
    // what an accepted reply can emit. Literal fixtures, so the web suite stays
    // independent of the AI package's tests.
    // The line ending inside the span reaches the reader as a space, which is the
    // one place the published text differs from what was written.
    it.each([
        { markdown: 'Use `` a\n```b `` here.', code: 'a ```b', text: 'Use a ```b here.' },
        // The run opening the second line is the closing run itself.
        { markdown: 'Quote ``` a\n``` b ``` here.', code: 'a', text: 'Quote a b ``` here.' },
        {
            markdown: 'Render ``<Provider />\n```tsx literal`` verbatim.',
            code: '<Provider /> ```tsx literal',
            text: 'Render <Provider /> ```tsx literal verbatim.',
        },
    ])('publishes $markdown as one span across a line break', ({ markdown, code, text }) => {
        const { container } = render(
            <ChatMessage
                message={{ id: 'multiline-span-fixture', role: 'assistant', content: markdown }}
            />,
        );
        const prose = container.querySelector('.prose') ?? container;

        expect([...prose.querySelectorAll('p > code')].map((node) => node.textContent)).toEqual([
            code,
        ]);
        expect(prose.textContent).toBe(text);
        expect(prose.querySelectorAll('p')).toHaveLength(1);
        expect(prose.querySelectorAll('pre')).toHaveLength(0);
        expect(prose.querySelectorAll('a')).toHaveLength(0);
        expect(prose.querySelector('provider')).toBeNull();
    });

    // The boundary the row above stops at, and the reason the validator still
    // refuses these. A run left open on its line is not a span, and a backtick in a
    // fence's info string means it is not a fence either, so the renderer commits to
    // neither: it publishes the marker as literal paragraph text and reads every
    // following line as prose.
    it.each([
        { markdown: '```a`b\n<script>alert(1)</script>\n```', text: '```a`b' },
        { markdown: '```tsx`\n<Provider />\n```', text: '```tsx`\n<Provider />' },
        { markdown: '```literal code````', text: '```literal code````' },
    ])('publishes $markdown as literal text, not code', ({ markdown, text }) => {
        const { container } = render(
            <ChatMessage message={{ id: 'open-fixture', role: 'assistant', content: markdown }} />,
        );

        expect(container.querySelector('p')?.textContent).toBe(text);
        expect(container.querySelectorAll('p > code')).toHaveLength(0);
    });

    // The validator refuses raw HTML in prose and accepts a '<' the grammar closes
    // no tag around. These rows record what this configuration does with each side,
    // so the distinction it draws stays a recorded fact rather than an assumption.
    //
    // `wrapped` is the one difference a reader can see: an angle bracket the grammar
    // reads as text stays inside the paragraph it was written in, while raw HTML
    // replaces the paragraph and arrives as a bare node. Inline HTML inside a
    // sentence keeps its paragraph, so for that shape the two sides are
    // indistinguishable here and the validator's refusal rests on the grammar alone.
    //
    // `text` is the row that matters most: no configuration here mounts an element
    // for model-authored markup — there is no rehype-raw — so every spelling below
    // reaches the reader as its own literal characters. Adding a raw-HTML plugin
    // fails this test rather than silently turning an accepted reply into markup.
    it.each([
        { markdown: 'Runtimes on <v2 releases', wrapped: true },
        { markdown: 'Runtimes on <v2 releases are unsupported.', wrapped: true },
        { markdown: 'CopilotKit <1.9 is affected.', wrapped: true },
        { markdown: 'Set a <n threshold before the provider mounts.', wrapped: true },
        // Closed by the grammar into a tag, so read as HTML rather than as text.
        { markdown: 'Compare <v2 and >v3.', wrapped: true },
        { markdown: 'Runtimes on <v2 releases> are affected.', wrapped: true },
        { markdown: '<details><summary>Hide the answer</summary>unsafe</details>', wrapped: false },
        { markdown: '<img src=x onerror=alert(1)>', wrapped: false },
        { markdown: '<!-- hidden instructions -->', wrapped: false },
        { markdown: '<script>alert(1)</script>', wrapped: false },
    ])('publishes $markdown as escaped text', ({ markdown, wrapped }) => {
        const { container } = render(
            <ChatMessage message={{ id: 'html-fixture', role: 'assistant', content: markdown }} />,
        );
        const prose = container.querySelector('.prose') ?? container;

        expect(prose.textContent).toBe(markdown);
        expect(prose.querySelector('details, summary, img, script, br, div, span')).toBeNull();
        expect([...prose.children].map((node) => node.tagName)).toEqual(wrapped ? ['P'] : []);
    });

    // Where the two sides above meet on one line: an angle bracket the grammar
    // closes no tag around, and a code span beside it. This configuration publishes
    // the span as <code> with its contents inert — the example address in it is
    // text, not an anchor — and escapes every angle bracket outside it, whether or
    // not a '>' follows later on the line. The last two rows are the ones the
    // validator's mask is sized by: what the span encloses is inert, and what sits
    // outside it is not, including the escaped `<script>` and `<img>` the reader is
    // shown as characters. A renderer change that reads either side differently
    // fails here rather than moving the validator's boundary silently.
    it.each([
        {
            markdown: 'Compare <b, `https://example.invalid/steal`, and c> here.',
            text: 'Compare <b, https://example.invalid/steal, and c> here.',
            code: ['https://example.invalid/steal'],
        },
        {
            markdown: 'Compare a<b and `https://example.invalid/steal` > c.',
            text: 'Compare a<b and https://example.invalid/steal > c.',
            code: ['https://example.invalid/steal'],
        },
        {
            markdown: 'Use <b `x` > carefully.',
            text: 'Use <b x > carefully.',
            code: ['x'],
        },
        {
            markdown: 'Use <b `x`> carefully.',
            text: 'Use <b x> carefully.',
            code: ['x'],
        },
        {
            markdown: '<b`> x `<script>alert(1)</script>` y',
            text: '<b> x <script>alert(1)</script>` y',
            code: ['> x '],
        },
        {
            markdown: '<i`> a `<img src=x onerror=alert(1)>` b',
            text: '<i> a <img src=x onerror=alert(1)>` b',
            code: ['> a '],
        },
    ])('publishes $markdown with its code span inert', ({ markdown, text, code }) => {
        const { container } = render(
            <ChatMessage
                message={{ id: 'span-mask-fixture', role: 'assistant', content: markdown }}
            />,
        );
        const prose = container.querySelector('.prose') ?? container;

        expect(prose.textContent).toBe(text);
        expect([...prose.querySelectorAll('code')].map((node) => node.textContent)).toEqual(code);
        expect(prose.querySelectorAll('a')).toHaveLength(0);
        expect(prose.querySelector('script, img, b, i')).toBeNull();
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

    // What the reader is actually handed: the string `supportReplyDetails` composes
    // out of a validated reply, rather than any one field the evidence check ran
    // over. `hrefs` is the whole contract — the composed details may publish the
    // cited evidence link and nothing else, spelled exactly as cited.
    //
    // The second and fourth rows are the spellings publication used to emit, kept
    // because they are why the first and third are worth asserting: trimming the
    // field away from its indentation republished an inert example as a live link,
    // and escaping the applicability rewrote a cited URL into one that resolves
    // somewhere else. Literal fixtures, so the web suite stays independent of the
    // AI package's tests.
    const providerUrl = 'https://docs.copilotkit.ai/reference/provider';
    const guideUrl = 'https://docs.copilotkit.ai/reference/my-guide';
    const composed = (body: string, source: string) =>
        [body, '', '**API version:** v2', '', '**Sources**', '', `- [Source 1](<${source}>)`].join(
            '\n',
        );

    it.each([
        {
            form: 'an indented example block',
            content: composed(
                '    Read https://example.invalid/steal now.\n\n**Applies to:** React applications using the provider.',
                providerUrl,
            ),
            hrefs: [providerUrl],
            code: ['Read https://example.invalid/steal now.\n'],
        },
        {
            form: 'the same block trimmed off its indentation',
            content: composed(
                'Read https://example.invalid/steal now.\n\n**Applies to:** React applications using the provider.',
                providerUrl,
            ),
            hrefs: ['https://example.invalid/steal', providerUrl],
            code: [],
        },
        // A destination is decoded, so the cited spelling has to survive the trip:
        // the reference written into the source list decodes back to the URL the
        // evidence check approved, and the unescaped spelling below does not.
        {
            form: 'a source reference that decodes back to the cited URL',
            content: composed(
                '**Applies to:** React applications using the provider.',
                'https://docs.copilotkit.ai/search?a=1&amp;amp;b=2',
            ),
            hrefs: ['https://docs.copilotkit.ai/search?a=1&amp;b=2'],
            code: [],
        },
        {
            form: 'a source reference decoded away from the cited URL',
            content: composed(
                '**Applies to:** React applications using the provider.',
                'https://docs.copilotkit.ai/search?a=1&amp;b=2',
            ),
            hrefs: ['https://docs.copilotkit.ai/search?a=1&b=2'],
            code: [],
        },
        {
            form: 'a cited applicability URL',
            content: composed(
                `The provider supplies the connection to your runtime.\n\n**Applies to:** ${guideUrl}`,
                guideUrl,
            ),
            hrefs: [guideUrl, guideUrl],
            code: [],
        },
        {
            form: 'the same URL with its hyphen escaped',
            content: composed(
                'The provider supplies the connection to your runtime.\n\n**Applies to:** https://docs.copilotkit.ai/reference/my\\-guide',
                guideUrl,
            ),
            hrefs: ['https://docs.copilotkit.ai/reference/my%5C-guide', guideUrl],
            code: [],
        },
        // The composed string carries a cited address twice when the body autolinks
        // it: once in the body and once as the angle inline destination the sources
        // footer writes. The two syntaxes decode differently, so this records that
        // both land on the one href for an address holding a character the
        // validator's pattern scan cannot spell.
        {
            form: 'an autolinked applicability URL holding an apostrophe',
            content: composed(
                "See <https://docs.copilotkit.ai/reference/provider's> now.\n\n**Applies to:** React applications using the provider.",
                "https://docs.copilotkit.ai/reference/provider's",
            ),
            hrefs: [
                "https://docs.copilotkit.ai/reference/provider's",
                "https://docs.copilotkit.ai/reference/provider's",
            ],
            code: [],
        },
        {
            form: 'an autolinked applicability URL holding a backtick',
            content: composed(
                'See <https://docs.copilotkit.ai/reference/provider`name> now.\n\n**Applies to:** React applications using the provider.',
                'https://docs.copilotkit.ai/reference/provider`name',
            ),
            hrefs: [
                'https://docs.copilotkit.ai/reference/provider%60name',
                'https://docs.copilotkit.ai/reference/provider%60name',
            ],
            code: [],
        },
    ])('publishes composed details holding $form', ({ content, hrefs, code }) => {
        const { container } = render(
            <ChatMessage message={{ id: 'composed-fixture', role: 'assistant', content }} />,
        );

        expect(
            [...container.querySelectorAll('a')].map((node) => node.getAttribute('href')),
        ).toEqual(hrefs);
        expect([...container.querySelectorAll('pre code')].map((node) => node.textContent)).toEqual(
            code,
        );
    });

    // The applicability line alone, in the four spellings publication has to choose
    // between. `srcs` is as much of the contract as `hrefs` here: this renderer
    // passes a Markdown image straight through to an <img>, so a spelling that keeps
    // the image syntax intact publishes a remote fetch, and one that escapes it does
    // not. The second and fourth rows are the spellings publication used to emit,
    // recorded because they are why the first and third are worth asserting: a
    // backslash escape written against a bare address is read as more of the
    // address, and preserving an image span published the image. Literal fixtures,
    // so the web suite stays independent of the AI package's tests.
    it.each([
        {
            form: 'an emphasis run escaped around a bounded address',
            content: `**Applies to:** \\*\\*Read <${guideUrl}>\\*\\*`,
            hrefs: [guideUrl],
            srcs: [],
        },
        {
            form: 'the same run escaped around a bare address',
            content: `**Applies to:** \\*\\*Read ${guideUrl}\\*\\*`,
            hrefs: ['https://docs.copilotkit.ai/reference/my-guide%5C*%5C'],
            srcs: [],
        },
        {
            form: 'cited image syntax escaped to text',
            content: `**Applies to:** !\\[diagram\\](${guideUrl})`,
            hrefs: [guideUrl],
            srcs: [],
        },
        {
            form: 'the same image syntax preserved',
            content: `**Applies to:** ![diagram](${guideUrl})`,
            hrefs: [],
            srcs: [guideUrl],
        },
    ])('publishes an applicability line holding $form', ({ content, hrefs, srcs }) => {
        const { container } = render(
            <ChatMessage message={{ id: 'applies-fixture', role: 'assistant', content }} />,
        );

        expect(
            [...container.querySelectorAll('a')].map((node) => node.getAttribute('href')),
        ).toEqual(hrefs);
        expect(
            [...container.querySelectorAll('img')].map((node) => node.getAttribute('src')),
        ).toEqual(srcs);
    });

    // The two spellings above left open, each recorded next to the one publication
    // used to emit for it. `texts` is part of the contract here rather than only
    // `hrefs`: a bounded spelling is only faithful if the reader still sees the
    // address the reply cited, so the anchor's own text is asserted beside its href.
    //
    // Rows 1–2: an image nested inside a link. The outer node is a link, so the span
    // reached the reader intact and with it a live <img> — the surface this field
    // never publishes, and one the `srcs` column of row 2 records.
    // Rows 3–4: a scheme-less `www.` host. Angle brackets around one publish as part
    // of the address, so the bounded spelling carries the destination the grammar
    // publishes for it; row 4 is what the bare address published instead once an
    // escape was written against it.
    const wwwHost = 'www.copilotkit.ai/reference/provider';
    const wwwUrl = `http://${wwwHost}`;

    it.each([
        {
            form: 'cited image syntax nested in a link, escaped to text',
            content: `**Applies to:** \\[!\\[diagram\\](<${guideUrl}>)\\](<${guideUrl}>)`,
            hrefs: [guideUrl, guideUrl],
            texts: [guideUrl, guideUrl],
            srcs: [],
        },
        {
            form: 'the same nested image syntax preserved',
            content: `**Applies to:** [![diagram](${guideUrl})](${guideUrl})`,
            hrefs: [guideUrl],
            texts: [''],
            srcs: [guideUrl],
        },
        {
            form: 'an emphasis run escaped around a bounded scheme-less address',
            content: `**Applies to:** \\*\\*Read <${wwwUrl}>\\*\\*`,
            hrefs: [wwwUrl],
            texts: [wwwUrl],
            srcs: [],
        },
        {
            form: 'the same run escaped around the bare scheme-less address',
            content: `**Applies to:** \\*\\*Read ${wwwHost}\\*\\*`,
            hrefs: [`${wwwUrl}%5C*%5C`],
            texts: [`${wwwHost}\\*\\`],
            srcs: [],
        },
    ])('publishes an applicability line holding $form', ({ content, hrefs, texts, srcs }) => {
        const { container } = render(
            <ChatMessage message={{ id: 'applies-nested-fixture', role: 'assistant', content }} />,
        );

        expect(
            [...container.querySelectorAll('a')].map((node) => node.getAttribute('href')),
        ).toEqual(hrefs);
        expect([...container.querySelectorAll('a')].map((node) => node.textContent)).toEqual(texts);
        // The <img> is asserted rather than the `<link rel="preload" as="image">`
        // the renderer emits beside it: the preload exists only to prefetch that
        // element's src, and it is hoisted out of the container — not observable
        // here — so the element itself is the one that decides whether the reader's
        // browser fetches a remote resource.
        expect(
            [...container.querySelectorAll('img')].map((node) => node.getAttribute('src')),
        ).toEqual(srcs);
    });

    // The href side of the validator's reference-definition matrix. A definition
    // can put its destination on the line after `[ref]:`, where the container
    // re-states the markers it opened with; the validator has to mask exactly that
    // destination and nothing around it, and what "that destination" resolves to is
    // this renderer's answer rather than a reading of the spelling. Recorded here
    // so the AI package's rows are checked against a published href instead of a
    // handwritten one. `title` is asserted beside `href` on the last row: the
    // renderer publishes a definition's title as an attribute and never as a
    // destination, which is why a raw URL written there stays prose the validator
    // must still hold to the evidence set. Literal fixtures, so the web suite stays
    // independent of the AI package's tests.
    const searchUrl = 'https://docs.copilotkit.ai/search?a=1&b=2';
    const encodedSearchUrl = 'https://docs.copilotkit.ai/search?a=1&amp;b=2';

    it.each([
        {
            form: 'a literal destination carried by a block quote',
            content: `[documentation][ref]\n\n> [ref]:\n> ${providerUrl}`,
            hrefs: [providerUrl],
            titles: [null],
        },
        {
            form: 'an entity-encoded destination carried by a block quote',
            content: `[documentation][ref]\n\n> [ref]:\n> ${encodedSearchUrl}`,
            hrefs: [searchUrl],
            titles: [null],
        },
        {
            form: 'an escape-delimited destination carried by a block quote',
            content:
                '[documentation][ref]\n\n> [ref]:\n> https://docs.copilotkit.ai/reference/setup\\)',
            hrefs: ['https://docs.copilotkit.ai/reference/setup)'],
            titles: [null],
        },
        {
            form: 'an angle-delimited destination carried by a nested block quote',
            content: `[documentation][ref]\n\n> > [ref]:\n> > <${encodedSearchUrl}>`,
            hrefs: [searchUrl],
            titles: [null],
        },
        {
            form: 'an entity-encoded destination carried by a quote in a list item',
            content: `[documentation][ref]\n\n- > [ref]:\n  > ${encodedSearchUrl}`,
            hrefs: [searchUrl],
            titles: [null],
        },
        {
            form: 'an entity-encoded destination carried by a list item',
            content: `[documentation][ref]\n\n- [ref]:\n  ${encodedSearchUrl}`,
            hrefs: [searchUrl],
            titles: [null],
        },
        {
            form: 'an ungrounded destination carried by a block quote',
            content: '[documentation][ref]\n\n> [ref]:\n> https://example.invalid/steal',
            hrefs: ['https://example.invalid/steal'],
            titles: [null],
        },
        {
            form: 'a raw URL written into the title rather than the destination',
            content: `[documentation][ref]\n\n> [ref]:\n> ${providerUrl}\n> "https://example.invalid/steal"`,
            hrefs: [providerUrl],
            titles: ['https://example.invalid/steal'],
        },
    ])('publishes a reference definition holding $form', ({ content, hrefs, titles }) => {
        const { container } = render(
            <ChatMessage message={{ id: 'definition-fixture', role: 'assistant', content }} />,
        );

        expect(
            [...container.querySelectorAll('a')].map((node) => node.getAttribute('href')),
        ).toEqual(hrefs);
        expect(
            [...container.querySelectorAll('a')].map((node) => node.getAttribute('title')),
        ).toEqual(titles);
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

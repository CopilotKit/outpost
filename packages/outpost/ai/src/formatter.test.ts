import { describe, it, expect } from 'vitest';
import type { SupportReply } from './support-reply.js';
import type { FormattedResponse } from './types.js';
import {
    AI_DISCLAIMER,
    AI_DISCLAIMER_ESCALATED,
    AI_DISCLAIMER_REVIEWED,
    ResponseFormatter,
    publishableText,
} from './formatter.js';

describe('disclaimer copy', () => {
    it('opens every variant with the plain AI-generated sentence', () => {
        expect(AI_DISCLAIMER).toBe('This is an AI-generated response.');
        expect(AI_DISCLAIMER_ESCALATED.startsWith(AI_DISCLAIMER)).toBe(true);
        expect(AI_DISCLAIMER_REVIEWED.startsWith(AI_DISCLAIMER)).toBe(true);
    });

    it('never volunteers a judgement about the response quality', () => {
        for (const text of [AI_DISCLAIMER, AI_DISCLAIMER_ESCALATED, AI_DISCLAIMER_REVIEWED]) {
            expect(text).not.toMatch(/incomplete|inaccurate|may not be|unreliable/i);
        }
    });

    it('only the escalated variant promises a follow-up in-thread', () => {
        expect(AI_DISCLAIMER_ESCALATED).toContain("We've escalated this to our engineering team");
        expect(AI_DISCLAIMER_REVIEWED).not.toContain('escalated');
    });
});

describe('ResponseFormatter', () => {
    const formatter = new ResponseFormatter();

    describe('Discord formatting', () => {
        it('should format response within 2000-char limit', () => {
            const result = formatter.format('Hello, here is your answer.', 'discord');

            expect(result.text).toContain('Hello, here is your answer.');
            expect(result.text).toContain('Powered by CopilotKit AI');
            expect(result.text.length).toBeLessThanOrEqual(2000);
            expect(result.truncated).toBe(false);
        });

        it('should include action buttons', () => {
            const result = formatter.format('Answer text', 'discord');

            expect(result.buttons).toBeDefined();
            expect(result.buttons).toHaveLength(3);
            expect(result.buttons![0].action).toBe('feedback_positive');
            expect(result.buttons![2].action).toBe('escalate');
        });

        it('should split long responses into multiple parts', () => {
            const longText = 'A'.repeat(2500);
            const result = formatter.format(longText, 'discord');

            expect(result.truncated).toBe(true);
            expect(result.parts).toBeDefined();
            expect(result.parts!.length).toBeGreaterThan(1);
            // Each part should be within limits
            for (const part of result.parts!) {
                expect(part.length).toBeLessThanOrEqual(2000);
            }
        });

        it('should handle code block splitting correctly', () => {
            // Create a message with a code block that forces a split
            const codeBlock = '```typescript\n' + 'const x = 1;\n'.repeat(150) + '```';
            const result = formatter.format(codeBlock, 'discord');

            if (result.parts && result.parts.length > 1) {
                // If split happened inside a code block, each part should have balanced fences
                for (const part of result.parts) {
                    const fenceCount = (part.match(/```/g) || []).length;
                    expect(fenceCount % 2).toBe(0);
                }
            }
        });

        it('should add disclaimer when requested', () => {
            const result = formatter.format('Answer text', 'discord', {
                addDisclaimer: true,
            });

            expect(result.text).toContain('AI-generated response');
        });

        it('never hedges about completeness on any platform', () => {
            for (const platform of ['discord', 'github', 'slack', 'teams', 'web'] as const) {
                const result = formatter.format('Answer text', platform, {
                    addDisclaimer: true,
                });
                expect(result.text).not.toMatch(/may be incomplete|might be incomplete/i);
                expect(result.text).toContain(AI_DISCLAIMER);
            }
        });

        it('should use custom disclaimer text', () => {
            const result = formatter.format('Answer text', 'discord', {
                addDisclaimer: true,
                disclaimerText: 'Low confidence response',
            });

            expect(result.text).toContain('Low confidence response');
        });
    });

    // Discord rejects any message over 2000 characters, so the formatter owns a
    // budget, not a preference. The footer is part of what it must fit: it is 109
    // UTF-16 units and is appended AFTER the split, so a splitter that reserves
    // less than that hands Discord an oversized last message — and whatever the
    // formatter does to force it back under the cap is damage to copy a user reads.
    //
    // These cases are stated as the posting contract rather than as the splitter's
    // internals, because the contract is what the Discord adapter consumes: it posts
    // `parts` when present and `text` otherwise (shared/src/platforms/discord.ts),
    // so "a message" means one element of that sequence.
    describe('Discord 2000-character budget', () => {
        // Derived through the public API rather than copied from the source, so this
        // tracks the real footer instead of asserting against a second copy of it:
        // an empty body formats to the footer and nothing else.
        const FOOTER = formatter.format('', 'discord').text;

        // A high surrogate not followed by a low one, or a low surrogate not preceded
        // by a high one. Either is an unpaired code unit — not a rendering nit but an
        // ill-formed string, which is what slicing at an arbitrary index produces when
        // the index lands in the middle of an astral character such as 👍.
        const LONE_SURROGATE =
            /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

        /** The exact message sequence the Discord adapter will post, in order. */
        function messagesFor(result: FormattedResponse): string[] {
            return result.parts?.length ? result.parts : [result.text];
        }

        /** The invariants that hold for every Discord response, split or not. */
        function postableMessages(result: FormattedResponse): string[] {
            const messages = messagesFor(result);
            for (const message of messages) {
                expect(message.length).toBeLessThanOrEqual(2000);
                expect(message).not.toMatch(LONE_SURROGATE);
                expect(message.endsWith('...')).toBe(false);
            }
            // One complete footer, closing the last message and appearing nowhere else.
            expect(messages[messages.length - 1].endsWith(FOOTER)).toBe(true);
            const footerOccurrences = messages.reduce(
                (total, message) => total + message.split(FOOTER).length - 1,
                0,
            );
            expect(footerOccurrences).toBe(1);
            return messages;
        }

        it('reserves the whole footer, not a smaller fixed allowance', () => {
            // 1892 is the first body length whose single message would exceed the cap
            // only once the footer is counted — the first size a 50-character reserve
            // gets wrong.
            const messages = postableMessages(formatter.format('A'.repeat(1892), 'discord'));

            expect(messages.length).toBeGreaterThan(1);
            expect(messages.join('')).toContain('A'.repeat(1892).slice(0, 100));
        });

        it('keeps the Docs link and the reaction prompt whole at every near-limit size', () => {
            // The whole window where body + footer lands just over the cap. Sizes below
            // it fit in one message and sizes above it split on their own; in between is
            // where an under-reserved budget silently eats the end of the footer — the
            // Docs URL at one size, the 👍/👎 prompt at another.
            for (let length = 1880; length <= 1960; length++) {
                const messages = postableMessages(formatter.format('A'.repeat(length), 'discord'));
                const last = messages[messages.length - 1];

                expect(last, `body length ${length}`).toContain(
                    '[Docs](https://docs.copilotkit.ai)',
                );
                expect(last, `body length ${length}`).toContain('React with 👍 or 👎');
            }
        });

        it('never emits an unpaired surrogate half of the footer emoji', () => {
            // At this size the old cap landed between the two code units of 👍 and
            // shipped a bare \uD83D to Discord.
            const messages = postableMessages(formatter.format('A'.repeat(1896), 'discord'));

            expect(messages.join('')).not.toMatch(LONE_SURROGATE);
        });

        it('closes an already-split response with the footer intact', () => {
            // Same failure one part further along: the body splits on its own, and the
            // last part is then the one that overflows when the footer is appended.
            const messages = postableMessages(formatter.format('A'.repeat(3899), 'discord'));

            expect(messages.length).toBeGreaterThan(2);
        });

        // Already true before the budget was corrected — plain prose was never the
        // part that got cut. It is here as a guard on the split point itself: the
        // split consumes the separator it broke on, and nothing else.
        it('carries every word of a split body across the parts, in order', () => {
            const words = Array.from({ length: 700 }, (_, index) => `word${index}`);
            const body = words.join(' ');

            const messages = postableMessages(formatter.format(body, 'discord'));
            const last = messages[messages.length - 1];
            const bodyAsPosted = [...messages.slice(0, -1), last.slice(0, -FOOTER.length)]
                .join(' ')
                .split(/\s+/)
                .filter(Boolean);

            expect(bodyAsPosted).toEqual(words);
        });

        it('preserves the indentation of every code line it splits between', () => {
            // A split consumes the newline it broke on. It must not also consume the
            // leading whitespace of the line that follows, which inside a fence is the
            // code's own indentation — losing it rewrites the snippet the user copies.
            const lines = Array.from(
                { length: 90 },
                (_, index) => `        indented line ${index} padding padding padding`,
            );
            const body = '```ts\n' + lines.join('\n') + '\n```';

            const messages = postableMessages(formatter.format(body, 'discord'));

            expect(messages.length).toBeGreaterThan(1);
            for (const line of lines) {
                expect(messages.filter((message) => message.includes(line))).toHaveLength(1);
            }
        });

        it('leaves room for the fences it adds when it splits inside a code block', () => {
            // Closing a fence on one part and reopening it on the next adds characters
            // the splitter did not measure. Sweeping the body length walks that overhead
            // across the cap instead of guessing which single size lands on it, and walks
            // the last part through the window where the footer no longer fits.
            for (let lineCount = 100; lineCount <= 240; lineCount++) {
                const body = '```typescript\n' + 'const value = 1;\n'.repeat(lineCount) + '```';
                const messages = postableMessages(formatter.format(body, 'discord'));

                for (const message of messages) {
                    expect(
                        (message.match(/```/g) ?? []).length % 2,
                        `line count ${lineCount}`,
                    ).toBe(0);
                }
            }
        });

        it('splits a non-ASCII body without dropping or halving a character', () => {
            // Length in UTF-16 units is not length in characters. A body of astral and
            // multi-byte characters crosses the cap at a different sentence count and
            // offers far more indices that sit inside a character, so the count is swept
            // rather than guessed.
            for (let sentenceCount = 60; sentenceCount <= 140; sentenceCount++) {
                const sentences = Array.from(
                    { length: sentenceCount },
                    (_, index) => `手順${index}：プロバイダーを設定してください 🙂🚀`,
                );
                const messages = postableMessages(
                    formatter.format(sentences.join('\n'), 'discord'),
                );

                for (const sentence of sentences) {
                    expect(
                        messages.filter((message) => message.includes(sentence)),
                        `sentence count ${sentenceCount}`,
                    ).toHaveLength(1);
                }
            }
        });
    });

    describe('GitHub formatting', () => {
        it('should include GitHub footer', () => {
            const result = formatter.format('Answer text', 'github');

            expect(result.text).toContain('Generated by CopilotKit AI Support');
            expect(result.text).toContain('Documentation');
            expect(result.truncated).toBe(false);
        });

        it('should wrap long code blocks in collapsible details', () => {
            const longCode = '```typescript\n' + 'const x = 1;\n'.repeat(50) + '```';
            const result = formatter.format(longCode, 'github');

            expect(result.text).toContain('<details>');
            expect(result.text).toContain('<summary>');
            expect(result.text).toContain('</details>');
        });

        it('should not wrap short code blocks in details', () => {
            const shortCode = '```typescript\nconst x = 1;\n```';
            const result = formatter.format(shortCode, 'github');

            expect(result.text).not.toContain('<details>');
        });
    });

    describe('Web formatting', () => {
        it('should include web footer', () => {
            const result = formatter.format('Answer text', 'web');

            expect(result.text).toContain('Powered by CopilotKit AI');
            expect(result.truncated).toBe(false);
        });

        it('should strip script tags', () => {
            const xss = 'Answer <script>alert("xss")</script> text';
            const result = formatter.format(xss, 'web');

            expect(result.text).not.toContain('<script>');
        });

        it('should strip iframe tags', () => {
            const xss = 'Answer <iframe src="evil.com"></iframe> text';
            const result = formatter.format(xss, 'web');

            expect(result.text).not.toContain('<iframe');
        });

        it('should strip event handlers', () => {
            const xss = 'Answer <div onclick="alert(1)">click me</div>';
            const result = formatter.format(xss, 'web');

            expect(result.text).not.toContain('onclick');
        });
    });
});

describe('structured support formatting', () => {
    const formatter = new ResponseFormatter();

    function reply(overrides: Partial<SupportReply> = {}): SupportReply {
        return {
            decision: 'answer',
            summary: 'Mount your chat inside the configured provider.',
            details: 'Configure the provider with your runtime URL.',
            apiVersion: 'v2',
            appliesTo: 'React applications',
            evidence: [
                {
                    sourceUrl: 'https://docs.copilotkit.ai/provider',
                    quote: 'Configure the provider with your runtime URL.',
                },
            ],
            handoffReason: '',
            ...overrides,
        };
    }

    it('starts GitHub with the useful summary and puts disclosure after one details section', () => {
        const result = formatter.formatStructured(reply(), 'github', {
            addDisclaimer: true,
            disclaimerText: AI_DISCLAIMER_ESCALATED,
        });
        expect(result.text.startsWith(reply().summary)).toBe(true);
        expect(result.text).toContain('<details><summary>Technical details and sources</summary>');
        expect(result.text.match(/<details>/g)).toHaveLength(1);
        expect(result.text.indexOf(AI_DISCLAIMER_ESCALATED)).toBeGreaterThan(
            result.text.indexOf('</details>'),
        );
        expect(result.text).toContain('Generated by CopilotKit AI Support');
    });

    it('keeps long code literal inside the single GitHub details wrapper', () => {
        const code = '```tsx\n' + '<Provider />\n'.repeat(50) + '```';
        const result = formatter.formatStructured(reply({ details: code }), 'github');
        expect(result.text).toContain(code);
        expect(result.text).not.toContain('&lt;Provider');
        expect(result.text.match(/<details>/g)).toHaveLength(1);
        expect(result.text).not.toContain('Code example');
    });

    it('returns web details separately while keeping the summary in the main text', () => {
        const result = formatter.formatStructured(reply(), 'web', { addDisclaimer: true });
        expect(result.text.startsWith(reply().summary)).toBe(true);
        expect(result.text).not.toContain(reply().details);
        expect(result.text).toContain('Powered by CopilotKit AI');
        expect(result.details).toContain(reply().details);
        expect(result.details).toContain('https://docs.copilotkit.ai/provider');
        expect(result.details).not.toContain('<details>');
    });

    it.each(['discord', 'slack', 'teams'] as const)(
        'uses ordinary platform formatting for %s',
        (platform) => {
            const result = formatter.formatStructured(reply(), platform);
            expect(result.text.startsWith(reply().summary)).toBe(true);
            expect(result.text).toContain(reply().details);
            expect(result.text).not.toContain('<details>');
            if (platform === 'discord') expect(result.buttons).toHaveLength(3);
        },
    );

    // The composed details are the last transform between a validated reply and the
    // reader, and the source list is the one part of them this formatter's caller
    // appends rather than the model writing it. Every destination it introduces has
    // to be an evidence URL, and where there is no evidence it introduces none.
    it('appends a source list holding only evidence destinations', () => {
        const value = reply({
            evidence: [
                { sourceUrl: 'https://docs.copilotkit.ai/provider', quote: 'Configure it.' },
                { sourceUrl: 'https://docs.copilotkit.ai/runtime', quote: 'Mount it.' },
            ],
        });
        const details = formatter.formatStructured(value, 'web').details ?? '';

        expect([...details.matchAll(/]\(<([^>]*)>\)/g)].map((match) => match[1])).toEqual(
            value.evidence.map((evidence) => evidence.sourceUrl),
        );
        expect(details).not.toMatch(/https?:\/\/(?!docs\.copilotkit\.ai\/(provider|runtime)\b)/);
    });

    it('appends no destination at all to a reply carrying no evidence', () => {
        const details = formatter.formatStructured(reply({ evidence: [] }), 'web').details ?? '';

        expect(details).not.toContain('**Sources**');
        expect(details).not.toMatch(/https?:\/\//);
    });

    it.each(['discord', 'github', 'slack', 'teams', 'web'] as const)(
        'renders routes plainly on %s without draft details',
        (platform) => {
            const result = formatter.formatStructured(
                reply({ decision: 'route', handoffReason: 'Internal routing reason' }),
                platform,
            );
            expect(result.text.startsWith(reply().summary)).toBe(true);
            expect(result.text).not.toContain(reply().details);
            expect(result.text).not.toContain('Internal routing reason');
            expect(result.text).not.toContain('<details>');
            expect(result.details).toBeUndefined();
            expect(result.completeText).toBeUndefined();
        },
    );

    // The web split is a UI contract, not a serialization: `text` and `details`
    // are two panes of one disclosure, and `text` already carries the footer that
    // closes the whole response. A sink that can only hold one string therefore
    // cannot be served by concatenating them — that buries the footer and the
    // disclaimer mid-response. `completeText` is the formatter answering that
    // question itself, since it is the only place that knows where the footer goes.
    describe('web completeText', () => {
        it('closes the single-string serialization with the footer, after the details', () => {
            const result = formatter.formatStructured(reply(), 'web', {
                addDisclaimer: true,
                disclaimerText: AI_DISCLAIMER_ESCALATED,
            });
            const complete = result.completeText ?? '';

            expect(complete.startsWith(reply().summary)).toBe(true);
            expect(complete.endsWith('\n\n---\n*Powered by CopilotKit AI*')).toBe(true);
            expect(complete.indexOf(reply().details)).toBeGreaterThan(
                complete.indexOf(reply().summary),
            );
            expect(complete.indexOf(AI_DISCLAIMER_ESCALATED)).toBeGreaterThan(
                complete.indexOf(reply().details),
            );
            expect(complete.indexOf('*Powered by CopilotKit AI*')).toBeGreaterThan(
                complete.indexOf(AI_DISCLAIMER_ESCALATED),
            );
        });

        it('carries the footer, disclaimer, summary and details exactly once each', () => {
            const result = formatter.formatStructured(reply(), 'web', {
                addDisclaimer: true,
                disclaimerText: AI_DISCLAIMER_REVIEWED,
            });
            const complete = result.completeText ?? '';

            for (const once of [
                reply().summary,
                reply().details,
                AI_DISCLAIMER_REVIEWED,
                '*Powered by CopilotKit AI*',
                'https://docs.copilotkit.ai/provider',
            ]) {
                expect(complete.split(once)).toHaveLength(2);
            }
        });

        it('leaves the two-pane text/details UI contract untouched', () => {
            const result = formatter.formatStructured(reply(), 'web', { addDisclaimer: true });

            expect(result.text.startsWith(reply().summary)).toBe(true);
            expect(result.text).not.toContain(reply().details);
            expect(result.text.endsWith('\n\n---\n*Powered by CopilotKit AI*')).toBe(true);
            expect(result.details).toContain(reply().details);
            expect(result.details).not.toContain('*Powered by CopilotKit AI*');
        });
    });

    // Every platform whose `text` is already the whole response must stay byte-identical;
    // a second serialization is exactly the duplicate-footer bug in the other direction.
    it.each(['discord', 'github', 'slack', 'teams'] as const)(
        'leaves %s with no second serialization to disagree with its text',
        (platform) => {
            expect(formatter.formatStructured(reply(), platform).completeText).toBeUndefined();
        },
    );
});

describe('publishableText', () => {
    it('prefers the formatter-composed whole response over re-joining the panes', () => {
        expect(
            publishableText({
                text: 'Summary\n\n---\n*Powered by CopilotKit AI*',
                details: 'Details',
                completeText: 'Summary\n\nDetails\n\n---\n*Powered by CopilotKit AI*',
            }),
        ).toBe('Summary\n\nDetails\n\n---\n*Powered by CopilotKit AI*');
    });

    // Discord stores its first part in `text` as well; publishing both would repeat it.
    it('publishes Discord continuations once, in order, ahead of text', () => {
        expect(
            publishableText({ text: 'One', parts: ['One', 'Two', 'Three'], truncated: true }),
        ).toBe('One\n\nTwo\n\nThree');
    });

    // A FormattedResponse built before `completeText` existed — a hand-rolled fixture,
    // or a value read back from an older run — must serialize exactly as it used to.
    it('falls back to the historical text-then-details join without completeText', () => {
        expect(publishableText({ text: 'Summary', details: 'Details' })).toBe('Summary\n\nDetails');
        expect(publishableText({ text: 'Summary' })).toBe('Summary');
        expect(publishableText({ text: 'Summary', parts: [] })).toBe('Summary');
    });
});

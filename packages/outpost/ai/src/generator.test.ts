import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { LLMock } from '@copilotkit/aimock';
import {
    GROUNDING_RULES,
    SYSTEM_PROMPT_PREFIX,
    ResponseGenerator,
    buildChannelGuidance,
    extractResponseText,
} from './generator.js';
import { checkReply, HANDOFF_WORD_CAP } from './eval/rules.js';
import { ConfidenceLevel } from './types.js';
import type { SearchResult } from './types.js';

// ─── aimock setup ───────────────────────────────────────────────────────────

let mock: LLMock;
let originalBaseUrl: string | undefined;

beforeAll(async () => {
    mock = new LLMock({ port: 0 });
    await mock.start();
    originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = mock.url;
});

afterAll(async () => {
    if (originalBaseUrl === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
    } else {
        process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    }
    await mock.stop();
});

beforeEach(() => {
    mock.reset();
});

// ─── Test data ──────────────────────────────────────────────────────────────

const sampleSources: SearchResult[] = [
    {
        title: 'CopilotKit Actions',
        content: 'useCopilotAction lets you define actions...',
        score: 0.92,
        sourceUrl: 'https://docs.copilotkit.ai/actions',
    },
    {
        title: 'Getting Started',
        content: 'Install CopilotKit with npm...',
        score: 0.85,
        sourceUrl: 'https://docs.copilotkit.ai/quickstart',
    },
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ResponseGenerator', () => {
    let generator: ResponseGenerator;

    beforeEach(() => {
        generator = new ResponseGenerator({ apiKey: 'test-key' });
    });

    describe('generate', () => {
        it('should extract text across response blocks when the first block is non-text', () => {
            // Typed as the real union, no `as unknown` — the point of the fixture is
            // that it is a response the SDK could actually hand us, and the cast was
            // suppressing the check that proves it.
            const content: Anthropic.ContentBlock[] = [
                {
                    type: 'tool_use',
                    id: 'tool-1',
                    name: 'lookup',
                    input: {},
                    caller: { type: 'direct' },
                },
                { type: 'text', text: 'First part', citations: null },
                { type: 'text', text: 'and second part', citations: null },
            ];

            // Blank line, not concatenation: the blocks are separate emissions.
            expect(extractResponseText(content)).toBe('First part\n\nand second part');
            expect(extractResponseText([])).toBe('');
        });

        // The helper above is well covered on its own, but nothing drove a
        // multi-block response through `generate()` — reverting the call site to
        // first-block-only left the whole suite green, so a bad merge or a refactor
        // could put the original defect back silently. #187 touches this same file.
        it('sends no temperature at all when the model rejects one', async () => {
            mock.onMessage(/./, {
                content: 'Here is the answer.',
                usage: { input_tokens: 10, output_tokens: 10 },
            });

            await new ResponseGenerator({ apiKey: 'test-key', model: 'claude-opus-5' }).generate(
                { question: 'test' },
                sampleSources,
            );

            const body = mock.getLastRequest()?.body as Record<string, unknown>;
            expect(body.model).toBe('claude-opus-5');
            // Asserted on the VALUE, not key presence: aimock's journal is a
            // normalized view of the request and always carries a `temperature`
            // key, holding `undefined` when we sent none. Absence on the wire is
            // what model-capabilities.test.ts pins; this pins that the call site
            // routes through the gate at all.
            expect(body.temperature).toBeUndefined();
        });

        it('should read past a leading thinking block when generating', async () => {
            mock.onMessage(/./, {
                content: 'Use useCopilotAction for that.',
                reasoning: 'internal thinking that is not the answer',
                usage: { input_tokens: 400, output_tokens: 80 },
            });

            const result = await generator.generate({ question: 'test' }, sampleSources);

            // aimock puts the `thinking` block first, so first-block-only yields ''
            // and this lands in the degraded fallback instead.
            expect(result.text).toBe('Use useCopilotAction for that.');
            expect(result.degraded).toBe(false);
            expect(result.reasoning).not.toContain('no usable text');
        });

        // The `.trim()` half of the guard. Whitespace-only is the mode the API can
        // realistically produce for this call shape, and it was the untested half:
        // relaxing the check to `if (!responseText)` left the suite green, so a
        // `"\n\n"` completion would publish at whatever the retrieval score was.
        it('should return the safe fallback for a whitespace-only response', async () => {
            mock.onMessage(/./, {
                content: '   \n  ',
                usage: { input_tokens: 100, output_tokens: 2 },
            });

            const result = await generator.generate({ question: 'test' }, sampleSources);

            expect(result.text).toContain('unable to generate');
            expect(result.degraded).toBe(true);
            expect(result.reasoning).toContain('no usable text');
        });

        it('should return the safe fallback when the model produces no usable text', async () => {
            mock.onMessage(/./, {
                content: '',
                usage: { input_tokens: 100, output_tokens: 0 },
            });

            const result = await generator.generate({ question: 'test' }, sampleSources);

            expect(result.text).toContain('unable to generate');
            expect(result.confidenceScore).toBe(0);
            expect(result.degraded).toBe(true);
            // Asserted on the reason, not just the fallback: an API error, a
            // TypeError and this guard all land on the identical fallback text,
            // so `text` alone can't tell them apart. This pins that the guard
            // fired. It does not distinguish `content: ''` from a real
            // `content: []` — both join to `''` and throw the same error.
            expect(result.reasoning).toContain('no usable text');
        });

        it('should generate a response with confidence scoring', async () => {
            mock.onMessage(/./, {
                content: 'Here is how to use CopilotKit actions...',
                usage: { input_tokens: 500, output_tokens: 100 },
            });

            const result = await generator.generate(
                { question: 'How do I use CopilotKit actions?' },
                sampleSources,
            );

            expect(result.text).toBe('Here is how to use CopilotKit actions...');
            expect(result.confidenceScore).toBeGreaterThan(0);
            expect(result.confidenceLevel).toBeDefined();
            expect(result.sources).toEqual(sampleSources);
            expect(result.tokenUsage).toEqual({ inputTokens: 500, outputTokens: 100 });
            expect(result.latencyMs).toBeGreaterThanOrEqual(0);
        });

        it('should assign HIGH confidence for high-quality sources', async () => {
            mock.onMessage(/./, {
                content: 'Response text',
                usage: { input_tokens: 100, output_tokens: 50 },
            });

            const highQualitySources: SearchResult[] = [
                { title: 'A', content: 'Content A', score: 0.95 },
                { title: 'B', content: 'Content B', score: 0.9 },
                { title: 'C', content: 'Content C', score: 0.88 },
            ];

            const result = await generator.generate({ question: 'test' }, highQualitySources);

            expect(result.confidenceLevel).toBe(ConfidenceLevel.HIGH);
        });

        it('should assign LOW confidence when no sources available', async () => {
            mock.onMessage(/./, {
                content: 'I am not sure about this...',
                usage: { input_tokens: 100, output_tokens: 50 },
            });

            const result = await generator.generate({ question: 'test' }, []);

            expect(result.confidenceLevel).toBe(ConfidenceLevel.LOW);
        });

        it('should return graceful fallback on API error', async () => {
            mock.nextRequestError(429, { message: 'API rate limited' });

            const result = await generator.generate({ question: 'test' }, sampleSources);

            expect(result.text).toContain('unable to generate');
            expect(result.confidenceScore).toBe(0);
            expect(result.confidenceLevel).toBe(ConfidenceLevel.LOW);
        });

        it('should include conversation history for follow-ups', async () => {
            mock.onMessage(/./, {
                content: 'Follow-up answer',
                usage: { input_tokens: 200, output_tokens: 50 },
            });

            await generator.generate({ question: 'What about streaming?' }, sampleSources, [
                { role: 'user', content: 'How do I use actions?' },
                { role: 'assistant', content: 'You use useCopilotAction...' },
            ]);

            // Verify the request contained conversation history
            const lastReq = mock.getLastRequest();
            expect(lastReq).not.toBeNull();
            const body = lastReq!.body;
            expect(body).not.toBeNull();
            const messages = body!.messages;
            // Should contain the history messages
            const allMessages = messages as Array<{ role: string; content: string | null }>;
            const userMessages = allMessages.filter((m) => m.role === 'user');
            const assistantMessages = allMessages.filter((m) => m.role === 'assistant');
            expect(
                userMessages.some(
                    (m) =>
                        typeof m.content === 'string' &&
                        m.content.includes('How do I use actions?'),
                ),
            ).toBe(true);
            expect(
                assistantMessages.some(
                    (m) =>
                        typeof m.content === 'string' &&
                        m.content.includes('You use useCopilotAction...'),
                ),
            ).toBe(true);
        });
    });

    describe('buildChannelGuidance', () => {
        it('tells the model not to suggest joining Discord when asked from Discord', () => {
            const guidance = buildChannelGuidance('discord');
            expect(guidance).toContain('Channel Awareness');
            expect(guidance).toContain('ALREADY in Discord');
            expect(guidance).toContain('never suggest they "join the Discord"');
            expect(guidance).toContain('never share a Discord invite link');
        });

        it('tells the model not to suggest opening an issue when asked from GitHub', () => {
            const guidance = buildChannelGuidance('github');
            expect(guidance).toContain('Channel Awareness');
            expect(guidance).toContain('ALREADY on GitHub');
            expect(guidance).toContain('never suggest they "open an issue"');
        });

        it('covers Slack and Teams channels', () => {
            expect(buildChannelGuidance('slack')).toContain('ALREADY in Slack');
            expect(buildChannelGuidance('teams')).toContain('ALREADY in Teams');
        });

        it('returns an empty string when the source is unknown', () => {
            expect(buildChannelGuidance()).toBe('');
            expect(buildChannelGuidance(undefined)).toBe('');
        });

        it('always includes the general do-not-redirect rule for known channels', () => {
            for (const source of ['discord', 'github', 'slack', 'teams', 'web'] as const) {
                expect(buildChannelGuidance(source)).toContain(
                    'never redirect the user to the same channel',
                );
            }
        });
    });

    // Regression for CopilotKit/CopilotKit#6167: the bot posted "Bug Confirmed"
    // with invented CSS class names for a report it never reproduced. The
    // The generator is a single stateless call over retrieval results. It now
    // receives SOURCE CODE as well as docs, so the boundary the prompt has to
    // draw moved: retrieved code is fair to cite, un-retrieved files are not, and
    // a repro or a test run is still something it cannot do.
    // GROUNDING_RULES tells the model that code entries are shown with their file
    // path and that the code wins a disagreement with the docs. Both instructions
    // are unusable if a docs page and a code hit render identically, so the
    // rendering is part of the contract, not cosmetic.
    describe('buildSystemPrompt source labelling', () => {
        const generator = new ResponseGenerator({ apiKey: 'test-key' });
        const build = (sources: SearchResult[]) =>
            (
                generator as unknown as {
                    buildSystemPrompt: (s: SearchResult[], src?: undefined) => string;
                }
            ).buildSystemPrompt(sources, undefined);

        it('labels a code source distinctly from a docs source', () => {
            const prompt = build([
                {
                    title: 'packages/react-core/src/index.ts',
                    content: 'export const x = 1;',
                    score: 0.9,
                    kind: 'code',
                },
                {
                    title: 'api-reference/components/CopilotKit',
                    content: 'The CopilotKit provider.',
                    score: 0.8,
                    kind: 'docs',
                },
            ]);

            expect(prompt).toContain('[SOURCE CODE Source 1: packages/react-core/src/index.ts');
            expect(prompt).toContain('[DOCS Source 2: api-reference/components/CopilotKit');
        });

        // The JSON result format and the plain-text fallback carry no marker, so an
        // unlabelled source must not be asserted as either kind.
        it('leaves a source of unknown kind unlabelled', () => {
            const prompt = build([{ title: 'Untitled', content: 'something', score: 0.5 }]);

            expect(prompt).toContain('[Source 1: Untitled');
            expect(prompt).not.toContain('DOCS Source 1');
            expect(prompt).not.toContain('SOURCE CODE Source 1');
        });
    });

    describe('GROUNDING_RULES', () => {
        it('states the model has not reproduced or tested, and has read only what was retrieved', () => {
            expect(GROUNDING_RULES).toContain('reproduced');
            expect(GROUNDING_RULES).toContain('run any test');
            expect(GROUNDING_RULES).toContain(
                'not read any file that is not in the Documentation Context',
            );
        });

        // The regression guard that matters. This exact instruction was in the
        // prompt while retrieval was docs-only, and it is what told the model to
        // disclaim the best evidence it had once code search landed — the reason a
        // reporter was told a shipped feature had no timeline. If it comes back,
        // code search is silently neutered again.
        it('no longer claims the model cannot read the source at all', () => {
            expect(GROUNDING_RULES).not.toContain("have NOT read CopilotKit's source code");
        });

        it('allows citing retrieved code, since that is now in the context', () => {
            expect(GROUNDING_RULES).toContain('SOURCE CODE');
            expect(GROUNDING_RULES).toContain('cite the file');
        });

        // "Docs silence != feature missing" — the rule that stops the case-A
        // failure, where the docs not mentioning subagents became "not supported".
        it('forbids reading documentation silence as absence', () => {
            expect(GROUNDING_RULES).toContain('Documentation silence is not evidence');
            expect(GROUNDING_RULES).toContain('not supported');
        });

        it('resolves a code/docs conflict in favour of the code', () => {
            expect(GROUNDING_RULES).toContain('the code is what ships');
        });

        it('forbids confirming a bug or asserting a root cause', () => {
            expect(GROUNDING_RULES).toContain('Never confirm a bug');
            expect(GROUNDING_RULES).toContain('bug confirmed');
            expect(GROUNDING_RULES).toContain('root cause is');
        });

        it('restricts identifiers to ones present in the documentation context', () => {
            expect(GROUNDING_RULES).toContain('appear verbatim in the Documentation Context');
            expect(GROUNDING_RULES).toContain('CSS class names');
        });

        it('requires causal claims to stay marked as hypotheses', () => {
            expect(GROUNDING_RULES).toContain('hypothesis');
            expect(GROUNDING_RULES).toContain('never restate it as established fact');
        });

        it('forbids prescribing fixes to CopilotKit internals', () => {
            expect(GROUNDING_RULES).toContain('Do not prescribe fixes to CopilotKit');
        });

        it('prefers escalation over a plausible-sounding guess', () => {
            expect(GROUNDING_RULES).toContain('escalating to the team');
        });

        it('is wired into the system prompt and overrides the personality rules', () => {
            expect(SYSTEM_PROMPT_PREFIX).toContain(GROUNDING_RULES);
            expect(GROUNDING_RULES).toContain(
                'override the personality and formatting rules above',
            );
        });
    });

    // The prompt is the other half of `eval/rules.ts`. #241 landed the reply
    // rules as code while this prompt still mandated the shape they penalise —
    // "Always include code examples", "**bold headers**", "Was this helpful?" —
    // so the linter built to enforce the rules would have collapsed drafts the
    // prompt had just asked for. Root cause 2 in the Agent's Output Doc is that
    // contradiction: formatting was mandatory and having something to say was
    // not, so a short honest reply was impossible to produce.
    //
    // These tests pin the two halves together. The killed mandates cannot come
    // back silently, and each mechanical rule is asserted against the linter
    // that fails a reply for breaking it — so the prompt and the rule name the
    // same thing or the test goes red.
    describe('SYSTEM_PROMPT_PREFIX reply shape', () => {
        it('no longer mandates a code example in every reply', () => {
            expect(SYSTEM_PROMPT_PREFIX).not.toContain('Always include code examples');
        });

        it('no longer mandates bold headers and bullet points', () => {
            expect(SYSTEM_PROMPT_PREFIX).not.toContain('Structure responses with **bold headers**');
            expect(SYSTEM_PROMPT_PREFIX).not.toContain('Use bold for emphasis');
        });

        // The closing slot is what Case D filled with issue-writing advice once
        // it had no facts left to report.
        it('no longer requires a closing follow-up suggestion', () => {
            expect(SYSTEM_PROMPT_PREFIX).not.toContain('Was this helpful?');
            expect(SYSTEM_PROMPT_PREFIX).not.toContain('End with a relevant follow-up');
        });

        it('puts the verdict in the first sentence', () => {
            expect(SYSTEM_PROMPT_PREFIX).toContain('first sentence');
            expect(SYSTEM_PROMPT_PREFIX).toContain('never build up to it');
        });

        it('asks for one approach rather than a menu', () => {
            expect(SYSTEM_PROMPT_PREFIX).toContain('Never a menu of three');
        });

        it('ties length to the evidence instead of to a required layout', () => {
            expect(SYSTEM_PROMPT_PREFIX).toContain('Length follows the evidence');
            expect(SYSTEM_PROMPT_PREFIX).toContain('enough content to organise');
        });

        it('requires a docs page or repo file for a substantive claim', () => {
            expect(SYSTEM_PROMPT_PREFIX).toContain('repo file');
            expect(SYSTEM_PROMPT_PREFIX).toContain('only lives in code');
        });

        it('holds one API version per reply', () => {
            expect(SYSTEM_PROMPT_PREFIX).toContain('One version of the API per reply');
        });

        // The doc's "if someone asks about v1, answer the v1 question" — the
        // recommendation is v2, which is not the same as refusing the question
        // that was asked.
        it('answers a v1 question rather than redirecting it', () => {
            expect(SYSTEM_PROMPT_PREFIX).toContain('answer the v1 question');
        });
    });

    // Each of these pairs the prompt with the linter rule that fails a reply for
    // breaking it. Asserting the rule fails first is what keeps the pair honest:
    // a prompt line matched against a rule that no longer fires would pass while
    // enforcing nothing.
    describe('SYSTEM_PROMPT_PREFIX matches the linter rules', () => {
        const ruleFor = (reply: string, rule: string) =>
            checkReply(reply, []).find((r) => r.rule === rule);

        it('bans the praise opener the linter fails a reply for', () => {
            expect(
                ruleFor(`Great question. ${'detail '.repeat(20)}`, 'no-banned-phrases')?.passed,
            ).toBe(false);
            expect(SYSTEM_PROMPT_PREFIX).toContain('Great question');
        });

        it('bans the self-commentary the linter fails a reply for', () => {
            expect(
                ruleFor(`What I can't do from here is ${'detail '.repeat(20)}`, 'no-banned-phrases')
                    ?.passed,
            ).toBe(false);
            expect(SYSTEM_PROMPT_PREFIX).toContain("What I can't do from here");
        });

        it('bans the hedged name the linter fails a reply for', () => {
            expect(
                ruleFor(
                    `Use useCopilotAction or the equivalent hook. ${'detail '.repeat(20)}`,
                    'no-hedged-names',
                )?.passed,
            ).toBe(false);
            expect(SYSTEM_PROMPT_PREFIX).toContain('or the equivalent');
        });

        // The linter's carve-out is the same as the prompt's: naming the retired
        // package is only correct as a migration instruction, alongside the live
        // package that replaced it.
        it('bans the retired package the linter fails a reply for, with the same carve-out', () => {
            expect(
                ruleFor(`Install @copilotkitnext/react. ${'detail '.repeat(20)}`, 'no-dead-package')
                    ?.passed,
            ).toBe(false);
            expect(SYSTEM_PROMPT_PREFIX).toContain('@copilotkitnext');
            expect(SYSTEM_PROMPT_PREFIX).toContain('@copilotkit');
        });

        // Reads the cap off the rules module rather than restating 60, so moving
        // the cap moves the prompt or breaks this test.
        it('states the handoff cap the linter enforces', () => {
            expect(SYSTEM_PROMPT_PREFIX).toContain(`${HANDOFF_WORD_CAP} words`);
            expect(SYSTEM_PROMPT_PREFIX).toContain('two sentences');
        });
    });

    // Zero retrieval used to invite the model to answer "from general CopilotKit
    // knowledge if possible" — root cause 1 written into the prompt, and exactly
    // what produced an invented answer when Pathfinder returned nothing. With no
    // sources there is nothing to be right from, so the only correct reply is the
    // handoff.
    describe('buildSystemPrompt with no sources', () => {
        const generator = new ResponseGenerator({ apiKey: 'test-key' });
        const build = () =>
            (
                generator as unknown as {
                    buildSystemPrompt: (s: SearchResult[], src?: undefined) => string;
                }
            ).buildSystemPrompt([], undefined);

        it('does not invite an answer from general knowledge', () => {
            expect(build()).not.toContain('general CopilotKit knowledge');
        });

        it('asks for the handoff instead', () => {
            expect(build()).toContain('two-sentence handoff');
        });
    });

    describe('generateStream', () => {
        it('should yield text chunks from streaming response', async () => {
            mock.onMessage(/./, {
                content: 'Hello world',
                usage: { input_tokens: 100, output_tokens: 10 },
            });

            const chunks: string[] = [];
            for await (const chunk of generator.generateStream(
                { question: 'test' },
                sampleSources,
            )) {
                chunks.push(chunk);
            }

            // aimock streams the content in chunks; joined result should match
            expect(chunks.join('')).toBe('Hello world');
            expect(chunks.length).toBeGreaterThanOrEqual(1);
        });

        it('should yield error message on stream failure', async () => {
            mock.nextRequestError(500, { message: 'Stream interrupted' });

            const chunks: string[] = [];
            for await (const chunk of generator.generateStream({ question: 'test' }, [])) {
                chunks.push(chunk);
            }

            expect(chunks.join('')).toContain('Error generating response');
        });
    });
});

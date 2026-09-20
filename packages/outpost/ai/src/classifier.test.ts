import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { LLMock } from '@copilotkit/aimock';
import { TicketClassifier } from './classifier.js';
import { TicketPriority, TicketType } from './types.js';

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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('TicketClassifier', () => {
    let classifier: TicketClassifier;

    beforeEach(() => {
        classifier = new TicketClassifier({ provider: 'anthropic', apiKey: 'test-key' });
    });

    describe('classify', () => {
        // Reading only content[0] made every thinking-first model silently useless
        // here: the text block is second, `text` came out '', parseClassification
        // found nothing, and the call degraded to the heuristic with no error. That
        // is the shape of any request to a model with thinking on by default, which
        // is what removing the temperature gate makes reachable.
        // The PR's title claim, pinned at the call site rather than only in the
        // unit test for samplingParams. Every other test in this file constructs
        // the client with an allowlisted model, so the parameter is sent either
        // way and no assertion can tell whether the call site uses the gate.
        it('sends no temperature at all when the model rejects one', async () => {
            mock.onMessage(/./, {
                content: JSON.stringify({ priority: 'LOW', type: 'QUESTION', tags: [] }),
                usage: { input_tokens: 10, output_tokens: 10 },
            });

            await new TicketClassifier({
                provider: 'anthropic',
                apiKey: 'test-key',
                model: 'claude-opus-5',
            }).classify('how do I do the thing?');

            const body = mock.getLastRequest()?.body as Record<string, unknown>;
            expect(body.model).toBe('claude-opus-5');
            // Asserted on the VALUE, not key presence: aimock's journal is a
            // normalized view of the request and always carries a `temperature`
            // key, holding `undefined` when we sent none. Absence on the wire is
            // what model-capabilities.test.ts pins; this pins that the call site
            // routes through the gate at all.
            expect(body.temperature).toBeUndefined();
        });

        it('still sends it for a model that accepts one', async () => {
            mock.onMessage(/./, {
                content: JSON.stringify({ priority: 'LOW', type: 'QUESTION', tags: [] }),
                usage: { input_tokens: 10, output_tokens: 10 },
            });

            await new TicketClassifier({
                provider: 'anthropic',
                apiKey: 'test-key',
                model: 'claude-haiku-4-5-20251001',
            }).classify('how do I do the thing?');

            const body = mock.getLastRequest()?.body as Record<string, unknown>;
            expect(body.temperature).toBeDefined();
        });

        // The inner parse catch swallowed an empty response and returned a
        // hardcoded MEDIUM/OTHER while reporting degraded: false — throwing away
        // the heuristic verdict it had already computed, and telling the caller
        // nothing was wrong. Reachable the moment a thinking-default model is
        // configured, since maxClassifierTokens (512) is below a thinking turn.
        it('falls back to the heuristic, and says so, when the response has no text', async () => {
            mock.onMessage(/./, {
                content: '',
                reasoning: 'thought about it and emitted no text',
                usage: { input_tokens: 10, output_tokens: 10 },
            });

            const result = await classifier.classify(
                'TypeError: Cannot read properties of undefined in CopilotRuntime.',
            );

            expect(result.degraded).toBe(true);
            // The heuristic's own verdict, not the parse fallback's MEDIUM/OTHER.
            expect(result.priority).toBe(TicketPriority.HIGH);
        });

        it('should read past a leading thinking block', async () => {
            mock.onMessage(/./, {
                content: JSON.stringify({
                    priority: 'HIGH',
                    type: 'BUG',
                    tags: ['copilotkit-runtime'],
                    reasoning: 'Error report with stack trace',
                }),
                reasoning: 'internal thinking that is not the classification',
                usage: { input_tokens: 100, output_tokens: 40 },
            });

            const result = await classifier.classify(
                'TypeError: Cannot read properties of undefined in CopilotRuntime.',
            );

            // BUG, not the heuristic's default: proves the JSON was actually parsed.
            expect(result.type).toBe(TicketType.BUG);
            expect(result.tags).toContain('copilotkit-runtime');
        });

        it('should classify an error report as HIGH priority ISSUE', async () => {
            mock.onMessage(/./, {
                content: JSON.stringify({
                    priority: 'HIGH',
                    type: 'BUG',
                    tags: ['copilotkit-runtime', 'typescript'],
                    reasoning: 'Error report with stack trace',
                }),
                usage: { input_tokens: 100, output_tokens: 40 },
            });

            const result = await classifier.classify(
                'TypeError: Cannot read properties of undefined. Getting this error when using CopilotRuntime with TypeScript.',
            );

            expect(result.priority).toBe(TicketPriority.HIGH);
            expect(result.type).toBe(TicketType.BUG);
            expect(result.tags).toContain('copilotkit-runtime');
            expect(result.tokenUsage.inputTokens).toBe(100);
        });

        it('should classify a how-to question as FEATURE_REQUEST type', async () => {
            mock.onMessage(/./, {
                content: JSON.stringify({
                    priority: 'LOW',
                    type: 'FEATURE_REQUEST',
                    tags: ['actions', 'next.js'],
                    reasoning: 'How-to question about setup',
                }),
                usage: { input_tokens: 80, output_tokens: 30 },
            });

            const result = await classifier.classify(
                'How do I set up useCopilotAction in my Next.js app?',
            );

            expect(result.type).toBe(TicketType.FEATURE_REQUEST);
        });

        it('should override to HIGH priority when heuristic detects errors', async () => {
            // Claude says MEDIUM, but heuristic should override to HIGH because of error keywords
            mock.onMessage(/./, {
                content: JSON.stringify({
                    priority: 'MEDIUM',
                    type: 'BUG',
                    tags: ['react-ui'],
                    reasoning: 'Minor rendering issue',
                }),
                usage: { input_tokens: 80, output_tokens: 30 },
            });

            const result = await classifier.classify(
                'Error: CopilotChat component crashes on render with TypeError',
            );

            // Heuristic HIGH should override Claude's MEDIUM
            expect(result.priority).toBe(TicketPriority.HIGH);
        });

        it('should merge tags from heuristic and Claude', async () => {
            mock.onMessage(/./, {
                content: JSON.stringify({
                    priority: 'MEDIUM',
                    type: 'BUG',
                    tags: ['performance', 'cloud'],
                    reasoning: 'Performance concern',
                }),
                usage: { input_tokens: 80, output_tokens: 30 },
            });

            const result = await classifier.classify(
                'The CopilotKit runtime is slow when deployed to cloud. Performance is terrible with LangChain integration.',
            );

            // Should have tags from both sources, deduplicated
            expect(result.tags).toContain('performance');
            expect(result.tags).toContain('cloud');
            // Heuristic should detect langchain
            expect(result.tags).toContain('langchain');
        });

        it('should fall back to heuristic on API failure', async () => {
            mock.nextRequestError(500, { message: 'API error' });

            const result = await classifier.classify('Error: Cannot connect to CopilotKit runtime');

            expect(result.priority).toBe(TicketPriority.HIGH); // Error keyword triggers HIGH
            expect(result.type).toBe(TicketType.BUG);
            expect(result.tokenUsage.inputTokens).toBe(0);
        });

        it.each([
            'Security vulnerability: unauthenticated users can read private conversations.',
            'The latest runtime update caused data loss for our customers.',
            'Production outage: all customers are unable to reach the runtime.',
            'Our production service is down and customers cannot connect.',
        ])('preserves CRITICAL incidents when the model fails: %s', async (content) => {
            mock.nextRequestError(500, { message: 'API error' });

            expect(await classifier.classify(content)).toMatchObject({
                priority: TicketPriority.CRITICAL,
                degraded: true,
                tokenUsage: { inputTokens: 0, outputTokens: 0 },
            });
        });

        it.each([TicketPriority.LOW, TicketPriority.MEDIUM, TicketPriority.HIGH])(
            'keeps heuristic CRITICAL above model %s',
            async (priority) => {
                mock.onMessage(/./, {
                    content: JSON.stringify({
                        priority,
                        type: 'BUG',
                        tags: ['cloud'],
                        reasoning: 'Model underestimated the incident',
                    }),
                });

                expect(
                    await classifier.classify('Production outage: all requests fail'),
                ).toMatchObject({
                    priority: TicketPriority.CRITICAL,
                    degraded: false,
                });
            },
        );
    });

    describe('heuristicClassify', () => {
        it.each([
            'We found security vulnerabilities exposing private conversations.',
            'Customers report data-loss after upgrading the runtime.',
            'PRODUCTION OUTAGE: every request times out.',
        ])('detects explicit critical incidents: %s', (content) => {
            expect(classifier.heuristicClassify(content).priority).toBe(TicketPriority.CRITICAL);
        });

        it.each([
            ['Did a production outage occur?', 'A production outage occurred.'],
            ['Did data loss happen?', 'Data loss happened.'],
            ['Did you find a security vulnerability?', 'We found a security vulnerability.'],
            ['Has a production outage occurred?', 'A production outage has occurred.'],
            ['Has there been data loss?', 'There has been data loss.'],
            ['Has a security vulnerability been found?', 'A security vulnerability was found.'],
            ['Was there a production outage?', 'There was a production outage.'],
            ['Was any data loss reported?', 'Customers reported data loss.'],
            ['Was a security vulnerability found?', 'A security vulnerability was found.'],
            [
                'Were customers affected by a production outage?',
                'Customers were affected by a production outage.',
            ],
            ['Were there reports of data loss?', 'There were reports of data loss.'],
            ['Were any security vulnerabilities found?', 'Security vulnerabilities were found.'],
            ['Have there been production outages?', 'There have been production outages.'],
            ['Have we experienced data loss?', 'We have experienced data loss.'],
            ['Have security vulnerabilities been found?', 'Security vulnerabilities were found.'],
            ['Had there been a production outage?', 'There had been a production outage.'],
            ['Had data loss occurred?', 'Data loss had occurred.'],
            ['Had a security vulnerability been found?', 'A security vulnerability was found.'],
            ['Will this cause a production outage?', 'This caused a production outage.'],
            ['Will this cause data loss?', 'This caused data loss.'],
            [
                'Will this introduce a security vulnerability?',
                'This introduced a security vulnerability.',
            ],
        ])(
            'distinguishes an incident question from an affirmative report: %s',
            (question, report) => {
                expect(classifier.heuristicClassify(question).priority).toBe(TicketPriority.HIGH);
                expect(classifier.heuristicClassify(report).priority).toBe(TicketPriority.CRITICAL);
                expect(classifier.heuristicClassify(`${question} ${report}`).priority).toBe(
                    TicketPriority.CRITICAL,
                );
            },
        );

        it.each([
            'How do I prevent data loss?',
            'How can we avoid production outages?',
            'How do I prevent security vulnerabilities?',
            'What is a security vulnerability?',
            'There was no data loss',
            'We have not experienced data loss.',
            'Data loss did not occur.',
            'No security vulnerabilities were found.',
            'There was no production outage.',
        ])('keeps preventive or negated incidents at the existing HIGH baseline: %s', (content) => {
            expect(classifier.heuristicClassify(content).priority).toBe(TicketPriority.HIGH);
        });

        it.each([
            'How do I prevent data loss? We found a security vulnerability exposing conversations.',
            'There was no data loss. Our production service is down.',
            'No security vulnerabilities were found. The update caused data loss.',
            'Production outage: all requests fail. There was no data loss.',
        ])('retains an affirmative critical incident in a separate sentence: %s', (content) => {
            expect(classifier.heuristicClassify(content).priority).toBe(TicketPriority.CRITICAL);
        });

        it.each([
            'Error: CopilotChat crashes when opening a conversation.',
            'Production requests are slow but still succeeding.',
            'Security concern: review the authentication configuration.',
            'How do I configure security headers?',
            'What is the recommended security setup for production?',
            'Is there a way to set the critical logging level?',
        ])('keeps ordinary errors and general security questions at HIGH: %s', (content) => {
            expect(classifier.heuristicClassify(content).priority).toBe(TicketPriority.HIGH);
        });

        it('should detect error messages as HIGH priority', () => {
            const result = classifier.heuristicClassify(
                'TypeError: Cannot read property of undefined',
            );
            expect(result.priority).toBe(TicketPriority.HIGH);
            expect(result.type).toBe(TicketType.BUG);
        });

        it('should detect feature requests as LOW priority', () => {
            const result = classifier.heuristicClassify(
                'Feature request: It would be nice to have dark mode in the chat widget',
            );
            expect(result.priority).toBe(TicketPriority.LOW);
            expect(result.type).toBe(TicketType.FEATURE_REQUEST);
        });

        it('should detect how-to questions as LOW priority QUESTION', () => {
            const result = classifier.heuristicClassify(
                'How do I configure authentication for my copilot?',
            );
            expect(result.priority).toBe(TicketPriority.LOW);
            expect(result.type).toBe(TicketType.QUESTION);
        });

        it('should detect CopilotKit-specific tags', () => {
            const result = classifier.heuristicClassify(
                'Issue with useCopilotAction hook in my Next.js app using LangGraph',
            );
            expect(result.tags).toContain('actions');
            expect(result.tags).toContain('hooks');
            expect(result.tags).toContain('next.js');
            expect(result.tags).toContain('langgraph');
        });

        it('does not infer TypeScript from incidental letters in a subagent question', () => {
            const result = classifier.heuristicClassify('Does Deep Agents support subagents?');
            expect(result.tags).not.toContain('typescript');
        });

        it.each(['TypeScript', 'ts', 'TSX', 'component.tsx', 'index.ts'])(
            'still tags an explicit TypeScript mention: %s',
            (mention) => {
                expect(classifier.heuristicClassify(`Help with ${mention}`).tags).toContain(
                    'typescript',
                );
            },
        );

        it('should default to MEDIUM priority for ambiguous tickets', () => {
            const result = classifier.heuristicClassify(
                'I need help with my copilot configuration',
            );
            expect(result.priority).toBe(TicketPriority.MEDIUM);
        });
    });
});

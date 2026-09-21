import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { LLMock } from '@copilotkit/aimock';
import { TicketClassifier } from './classifier.js';
import { TicketPriority, TicketType } from './types.js';
import { useAimock } from './test-utils/aimock.js';

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
            'Security vulnerabilities were not found.',
            'A security vulnerability was not found.',
            'Production outage was not reported.',
            'Data loss was not found.',
            'No production outages were reported.',
            'No reports of data loss were found.',
        ])('keeps passive absence reports at the existing HIGH baseline: %s', (content) => {
            expect(classifier.heuristicClassify(content).priority).toBe(TicketPriority.HIGH);
        });

        it.each([
            'Security vulnerabilities were found.',
            'A security vulnerability was found.',
            'Production outage was reported.',
            'Customers reported data loss.',
        ])('keeps passive or reported critical incidents at CRITICAL: %s', (content) => {
            expect(classifier.heuristicClassify(content).priority).toBe(TicketPriority.CRITICAL);
        });

        it.each([
            'How do I prevent data loss? We found a security vulnerability exposing conversations.',
            'There was no data loss. Our production service is down.',
            'No security vulnerabilities were found. The update caused data loss.',
            'Production outage: all requests fail. There was no data loss.',
            'Security vulnerabilities were not found. Customers reported data loss.',
            'Production outage was not reported. A security vulnerability was found.',
        ])('retains an affirmative critical incident in a separate sentence: %s', (content) => {
            expect(classifier.heuristicClassify(content).priority).toBe(TicketPriority.CRITICAL);
        });

        it.each([
            'Security vulnerabilities were not found in staging, but security vulnerabilities were found in production.',
            'Data loss was not found in staging, but data loss was found in production.',
        ])('retains a later affirmative critical incident in the same sentence: %s', (content) => {
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

describe('critical incident context boundaries', () => {
    const aimock = useAimock();
    const incidentContexts = [
        [
            'Hi team, did data loss happen during the migration?',
            'Data loss happened during the migration.',
        ],
        ['Context: was any data loss reported?', 'Customers reported data loss.'],
        [
            'During the rollout, were security vulnerabilities found?',
            'Security vulnerabilities were found during the rollout.',
        ],
        ['Data loss?', 'Data loss occurred in production.'],
        ['Production outage?', 'A production outage occurred.'],
        ['Security vulnerability?', 'A security vulnerability was found.'],
        ['Production is down?', 'Production is down.'],
        ['Data loss has not occurred.', 'Data loss has occurred.'],
        ['A production outage has never been reported.', 'A production outage has been reported.'],
        [
            'Security vulnerabilities have not been found.',
            'Security vulnerabilities have been found.',
        ],
        [
            'We have not seen any customer reports of data loss.',
            'We have seen customer reports of data loss.',
        ],
        [
            'We did not receive any customer reports of production outages.',
            'We received customer reports of production outages.',
        ],
        [
            'We have never found any evidence of security vulnerabilities.',
            'We found evidence of security vulnerabilities.',
        ],
        [
            'Security vulnerabilities were not found in staging.',
            'Security vulnerabilities were found in production.',
        ],
        [
            'We are preventing data loss during migration.',
            'Customers report data-loss after upgrading the runtime.',
        ],
        [
            'We avoided production outages during the rollout.',
            'We experienced production outages during the rollout.',
        ],
        ['Data loss was avoided during the rollout.', 'Data loss occurred in production.'],
        ['Data loss is prevented by backups.', 'Data loss occurred in production.'],
        ['Data loss was prevented by backups.', 'Data loss occurred in production.'],
        ['Data loss avoided during the rollout.', 'Data loss occurred in production.'],
        ['Data loss has been avoided during the rollout.', 'Data loss occurred in production.'],
        ['Data loss has been prevented by backups.', 'Data loss occurred in production.'],
        ['Production outages were prevented.', 'Production outages occurred in production.'],
        ['Production outages were avoided.', 'Production outages occurred in production.'],
        [
            'Production outages prevented by safeguards.',
            'Production outages occurred in production.',
        ],
        [
            'Production outages are avoided by safeguards.',
            'Production outages occurred in production.',
        ],
        [
            'Production outages have been avoided during the rollout.',
            'Production outages occurred in production.',
        ],
        [
            'Production outages have been prevented by safeguards.',
            'Production outages occurred in production.',
        ],
        [
            'A security vulnerability was avoided.',
            'A security vulnerability was found in production.',
        ],
        [
            'A security vulnerability was prevented.',
            'A security vulnerability was found in production.',
        ],
        [
            'Security vulnerabilities are prevented by review.',
            'Security vulnerabilities were found in production.',
        ],
        [
            'A security vulnerability had been avoided before release.',
            'A security vulnerability was found in production.',
        ],
        [
            'A security vulnerability had been prevented before release.',
            'A security vulnerability was found in production.',
        ],
        [
            'Without any reported evidence of security vulnerabilities.',
            'There is evidence of security vulnerabilities.',
        ],
        [
            'Did the migration cause data loss, security vulnerabilities, or a production outage?',
            'The migration caused data loss, security vulnerabilities, and a production outage.',
        ],
        [
            'We have not seen data loss, security vulnerabilities, or production outages.',
            'We have seen data loss, security vulnerabilities, and production outages.',
        ],
        [
            'Data loss and production outages have not been reported.',
            'Data loss and production outages have been reported.',
        ],
        [
            "We haven't seen customer reports of data loss.",
            'We have seen customer reports of data loss.',
        ],
        [
            'We have not yet seen any reports of data loss.',
            'We have already seen reports of data loss.',
        ],
        ["Data loss hasn't occurred.", 'Data loss has occurred.'],
        [
            'Security vulnerabilities were not found.',
            'Security vulnerabilities were not only found, they were exploited.',
        ],
        ['Data loss did not occur.', 'Data loss was not only confirmed, it affected production.'],
        [
            'Production outage was not reported.',
            'Production outage was not only confirmed, it affected production.',
        ],
        [
            'We did not suffer data loss.',
            'Not only did we suffer data loss, but customers lost access.',
        ],
        [
            'Customers never experienced a production outage.',
            'Not only did customers experience a production outage, they lost access.',
        ],
        [
            'We shipped without security vulnerabilities.',
            'Not only were security vulnerabilities found, they were exploited.',
        ],
        [
            'Not only did we avoid data loss, we avoided a production outage.',
            'Not only did we suffer data loss, but customers lost access.',
        ],
        [
            'Not only was no data loss reported, no security vulnerability was found.',
            'Security vulnerabilities were not only found, they were exploited.',
        ],
        [
            'Data loss was not only avoided, production outages were prevented.',
            'Data loss was not only confirmed, it affected production.',
        ],
        [
            'Data loss was not only not observed, it never occurred.',
            'Data loss was not only confirmed, it affected production.',
        ],
    ];
    // Pair each grammar family with the same incident vocabulary and put the
    // affirmative clause on both sides. All three public boundaries share it.
    const cases = incidentContexts.flatMap(([nonIncident, report]) => [
        { content: nonIncident, priority: TicketPriority.HIGH },
        { content: report, priority: TicketPriority.CRITICAL },
        {
            content: `${nonIncident.replace(/[.?]$/, '')}, but ${report}`,
            priority: TicketPriority.CRITICAL,
        },
        {
            content: `${report.replace(/\.$/, '')}, but ${nonIncident}`,
            priority: TicketPriority.CRITICAL,
        },
    ]);
    const causalDiagnosticQuestions = [
        'Did this happen because data loss occurred?',
        'Could this be because a security vulnerability was found?',
        'Did this happen because a production outage occurred?',
        'Is this because customers reported data loss?',
        'Did this happen because data loss occurred or customers reported a security vulnerability?',
        'Did this happen because data loss occurred and production is down?',
    ];
    const adjacentReports = [
        'Data loss? The update caused data loss.',
        'Our production service is down and customers cannot connect.',
        'Data loss occurred, can you help?',
        'Can you help, data loss occurred.',
        'Data loss occurred and can you help us restore it?',
        'Can you help because production is down?',
        'Can you help because our production service is down?',
        'This happened because data loss occurred.',
        'Did this happen because data loss occurred? Production is down.',
        'We have not restarted the server and data loss occurred.',
        'Data loss occurred and we have not restarted the server.',
        'No users can connect because production is down.',
        'There was no production outage, yet data loss occurred.',
        'No customers report data loss and a production outage has been reported.',
        'A production outage has been reported and no customers report data loss.',
    ];
    const r6IncidentReports = [
        'No users could access the app during the production outage.',
        'Users without backups experienced data loss.',
        'The migration did not prevent data loss.',
        'A production outage prevented customers from logging in.',
        'Data loss avoided detection until Monday.',
        'We could not prevent data loss for customers.',
        'We failed to prevent data loss for customers.',
        'We did not prevent a production outage.',
        'We could not avoid a security vulnerability.',
    ];
    const r6PreservationControls = [
        {
            content: 'This is a hypothetical data loss scenario.',
            priority: TicketPriority.HIGH,
        },
        {
            content: 'We did not see any errors before data loss occurred.',
            priority: TicketPriority.CRITICAL,
        },
    ];
    cases.push(
        ...adjacentReports.map((content) => ({
            content,
            priority: TicketPriority.CRITICAL,
        })),
        ...causalDiagnosticQuestions.map((content) => ({
            content,
            priority: TicketPriority.HIGH,
        })),
        ...r6IncidentReports.map((content) => ({
            content,
            priority: TicketPriority.CRITICAL,
        })),
        ...r6PreservationControls,
    );

    cases.push({
        content: 'Did data loss occur in staging, or did data loss occur in production?',
        priority: TicketPriority.HIGH,
    });

    describe.each(['heuristic', 'model failure', 'healthy LOW model'] as const)(
        '%s',
        (boundary) => {
            it.each(cases)('$priority: $content', async ({ content, priority }) => {
                const classifier = new TicketClassifier({
                    provider: 'anthropic',
                    apiKey: 'test-key',
                    baseURL: aimock().url,
                });
                if (boundary === 'heuristic') {
                    expect(classifier.heuristicClassify(content).priority).toBe(priority);
                    return;
                }
                if (boundary === 'model failure') {
                    aimock().llm.nextRequestError(500, { message: 'API error' });
                } else {
                    aimock().llm.onMessage(/./, {
                        content: JSON.stringify({
                            priority: TicketPriority.LOW,
                            type: TicketType.QUESTION,
                            tags: [],
                            reasoning:
                                'A lower model judgment must respect only affirmative incidents.',
                        }),
                    });
                }
                expect(await classifier.classify(content)).toMatchObject({
                    priority,
                    degraded: boundary === 'model failure',
                });
            });
        },
    );
});

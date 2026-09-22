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
            'Production is currently down.',
            'Our production service is completely down.',
            'The production system is still down.',
            'The production environment is currently down.',
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
            'Production is currently down.',
            'Our production service is completely down.',
            'The production system is still down.',
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
        ['Is production currently down?', 'Production is currently down.'],
        ['Data loss has not occurred.', 'Data loss has occurred.'],
        ['A production outage has never been reported.', 'A production outage has been reported.'],
        [
            'Security vulnerabilities have not been found.',
            'Security vulnerabilities have been found.',
        ],
        ['This is not a security vulnerability.', 'A security vulnerability was found.'],
        ['This is not data loss.', 'Data loss occurred in production.'],
        ['This is not a production outage.', 'A production outage occurred.'],
        ['These are not security vulnerabilities.', 'Security vulnerabilities were found.'],
        ['That was not the production outage.', 'A production outage was reported.'],
        ['Those were not production outages.', 'Production outages occurred in production.'],
        ["This isn't a security vulnerability.", 'A security vulnerability was found.'],
        ['This isn’t data loss.', 'Data loss occurred in production.'],
        ["This isn't a production outage.", 'A production outage occurred.'],
        ["These aren't security vulnerabilities.", 'Security vulnerabilities were found.'],
        ["That wasn't the production outage.", 'A production outage was reported.'],
        ['Those weren’t production outages.', 'Production outages occurred in production.'],
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
            'Data loss or production outages have not been reported.',
            'Data loss or production outages have been reported.',
        ],
        [
            'Data loss, security vulnerabilities have not been reported.',
            'Data loss, security vulnerabilities have been reported.',
        ],
        [
            'Production outages, data loss have not been reported.',
            'Production outages, data loss have been reported.',
        ],
        [
            'Production outages, security vulnerabilities have not been reported.',
            'Production outages, security vulnerabilities have been reported.',
        ],
        [
            'Security vulnerabilities, data loss have not been reported.',
            'Security vulnerabilities, data loss have been reported.',
        ],
        [
            'Security vulnerabilities, production outages have not been reported.',
            'Security vulnerabilities, production outages have been reported.',
        ],
        [
            'Data loss, production outages, security vulnerabilities have not been reported.',
            'Data loss, production outages, security vulnerabilities have been reported.',
        ],
        ['No users had data loss.', 'Users had data loss.'],
        ['No users saw a production outage.', 'Users saw a production outage.'],
        ['No users reported a security vulnerability.', 'Users reported a security vulnerability.'],
        ['No customers had a security vulnerability.', 'Customers had a security vulnerability.'],
        ['No customers saw data loss.', 'Customers saw data loss.'],
        ['No customers reported a production outage.', 'Customers reported a production outage.'],
        [
            'No team members experienced a security vulnerability.',
            'Team members experienced a security vulnerability.',
        ],
        ['No team members had a production outage.', 'Team members had a production outage.'],
        ['No team members saw data loss.', 'Team members saw data loss.'],
        [
            'No team members reported a security vulnerability.',
            'Team members reported a security vulnerability.',
        ],
        ['We never had a production outage.', 'We had a production outage.'],
        ['We never had a security vulnerability.', 'We had a security vulnerability.'],
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
        'Did the crash happen because data loss occurred?',
        'Did the migration fail because production is down?',
        'Can this be because data loss occurred?',
    ];
    const adjacentReports = [
        'Users did experience data loss.',
        'Customers did experience a production outage.',
        'No users experienced data loss, but production is down.',
        'No users experienced data loss and production is down.',
        'No team members had a security vulnerability, production is down.',
        'Data loss occurred, production outages have not been reported.',
        'Data loss, production outages have not been reported, but production is down.',
        'Data loss, production outages have not been reported and production is down.',
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
        'Data loss was not prevented.',
        'A production outage was not avoided.',
        'A security vulnerability was not prevented.',
        "Data loss wasn't prevented.",
        "Production outages weren't avoided.",
        "A security vulnerability wasn't prevented.",
        'Data loss has not been prevented.',
        'Production outages have not been avoided.',
        "Data loss hasn't been prevented.",
        "A security vulnerability hadn't been prevented.",
    ];
    // Both suffix guards share one negated-predicate opener, so the adverb and
    // auxiliary forms it accepts have to resolve by verb class alone: a negated
    // prevention is still a failed prevention, a negated occurrence is still an
    // absence. Pinning both arms keeps the opener from drifting for one guard.
    const r13NegatedPredicateOpenerCases = [
        { content: 'Data loss has not yet been prevented.', priority: TicketPriority.CRITICAL },
        { content: 'A production outage could not be avoided.', priority: TicketPriority.CRITICAL },
        { content: 'Data loss has not yet occurred.', priority: TicketPriority.HIGH },
        { content: 'Data loss has never yet been reported.', priority: TicketPriority.HIGH },
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
    const ownerNoPreservationControls = [
        'We had no data loss',
        'We have no reports of data loss',
        'The team had no production outage',
    ];
    const denialRelationControls = [
        'This does not represent data loss.',
        'This does not constitute data loss.',
        'This is unrelated to data loss.',
        "This doesn't represent a production outage.",
        "This didn't constitute a security vulnerability.",
        'These are unrelated to production outages.',
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
        ...r13NegatedPredicateOpenerCases,
        ...r6PreservationControls,
        ...ownerNoPreservationControls.map((content) => ({
            content,
            priority: TicketPriority.HIGH,
        })),
        ...denialRelationControls.map((content) => ({
            content,
            priority: TicketPriority.HIGH,
        })),
    );

    cases.push({
        content: 'Did data loss occur in staging, or did data loss occur in production?',
        priority: TicketPriority.HIGH,
    });

    const sharedPredicateScopeCases = [
        {
            content: 'Data loss, production outages have not been reported.',
            priority: TicketPriority.HIGH,
        },
        {
            content: 'Data loss, production outages have been reported.',
            priority: TicketPriority.CRITICAL,
        },
        {
            content: 'Data loss, production outages have not been reported. Production is down.',
            priority: TicketPriority.CRITICAL,
        },
        {
            content:
                'Data loss, production outages, and security vulnerabilities have not been reported.',
            priority: TicketPriority.HIGH,
        },
    ];

    const polarityContrastCases = [
        { content: 'No users experienced data loss.', priority: TicketPriority.HIGH },
        { content: 'Users experienced data loss.', priority: TicketPriority.CRITICAL },
        {
            content: 'No users experienced data loss. Production is down.',
            priority: TicketPriority.CRITICAL,
        },
        {
            content: 'No customers experienced a production outage.',
            priority: TicketPriority.HIGH,
        },
        {
            content: 'Customers experienced a production outage.',
            priority: TicketPriority.CRITICAL,
        },
        {
            content: 'No customers experienced a production outage. Production is down.',
            priority: TicketPriority.CRITICAL,
        },
        { content: 'We never had data loss.', priority: TicketPriority.HIGH },
        { content: 'We had data loss.', priority: TicketPriority.CRITICAL },
        {
            content: 'We never had data loss. Production is down.',
            priority: TicketPriority.CRITICAL,
        },
    ];

    // Round-13 convergence lever L3 (audit class C3), incident-absence half:
    // enumerate the predicates the incident guard is allowed to cancel on
    // instead of widening it one alternative per round. Each row pairs a
    // negation that leaves the incident standing with the absence statement it
    // must not collapse into, and the pair is deliberately NOT asserted equal.
    // Separator and conditional coverage is R13-AI-A07's half of this lever.
    //
    // The `absent` column doubles as the must-accept control for the
    // subject-position lemmas the guard cancels on. `found`, `reported`,
    // `occur`, `occurred` and `observed` are already pinned by the
    // incidentContexts table above and are not restated here.
    const incidentAbsenceVersusRemediationContrasts = [
        {
            rationale: 'remediation verb: the vulnerability exists and is unpatched',
            unresolved: 'A security vulnerability has not been patched.',
            absent: 'A security vulnerability has not been seen.',
        },
        {
            rationale: 'remediation verb: the outage exists and is unmitigated',
            unresolved: 'The production outage has not been mitigated.',
            absent: 'The production outage has not been observed.',
        },
        {
            rationale: 'contracted remediation verb, same scope as the spelled-out form',
            unresolved: "The production outage hasn't been mitigated.",
            absent: "The production outage hasn't happened.",
        },
        {
            rationale: 'unresolved status, not an absent outage',
            unresolved: 'Production outage is not resolved.',
            absent: 'Production outage did not happen.',
        },
        {
            rationale: 'property of an incident that already occurred',
            unresolved: 'Data loss is not recoverable.',
            absent: 'Data loss has not happened.',
        },
        {
            rationale: 'negated discovery whose object is the root cause, not the data loss',
            unresolved: 'We have not found the data loss root cause.',
            absent: 'We have not found any data loss.',
        },
        {
            rationale: 'remediation verb: the outage exists and is uncontained',
            unresolved: 'The production outage has not been contained.',
            absent: 'A production outage was not experienced by customers.',
        },
        {
            rationale: 'remediation verb: the data loss exists and is unfixed',
            unresolved: 'Data loss has not been fixed.',
            absent: 'Data loss was not suffered by customers.',
        },
    ];
    const incidentAbsenceContrastCases = incidentAbsenceVersusRemediationContrasts.flatMap(
        ({ unresolved, absent }) => [
            { content: unresolved, priority: TicketPriority.CRITICAL },
            { content: absent, priority: TicketPriority.HIGH },
        ],
    );

    // The other direction of the same guard, and the one the first pass of this
    // fix got wrong: constraining cancellation to an enumerated verb class and
    // to an object the incident heads must not turn an *ordinary* absence
    // report into a CRITICAL. That error is unrecoverable — the floor never
    // downgrades and no healthy model judgment can undo it — so each `absent`
    // row here is pinned against the nearest phrasing that legitimately leaves
    // the incident standing, and the pair is asserted not to collapse.
    //
    // Two decisions are covered. The verb class: "detect" is an observation
    // verb, so negating it reports absence, while negating a repair verb does
    // not. The object head: a negative-polarity or -ly adverb closes the
    // negated object, while a further bare noun makes the incident a modifier
    // of some other head.
    const observedAbsenceVersusStandingIncidentContrasts = [
        {
            rationale: 'observation verb in subject position, passive',
            absent: 'Data loss has not been detected.',
            standing: 'Data loss has not been repaired.',
        },
        {
            rationale: 'observation verb in subject position, present perfect',
            absent: 'A production outage has not been detected.',
            standing: 'A production outage has not been resolved.',
        },
        {
            rationale: 'observation verb in subject position, simple past passive',
            absent: 'Security vulnerabilities were not detected.',
            standing: 'Security vulnerabilities were not patched.',
        },
        {
            rationale: 'observation verb under "never", not a never-performed repair',
            absent: 'Data loss has never been detected.',
            standing: 'Data loss has never been mitigated.',
        },
        {
            rationale: 'observation verb in object position, quantified object',
            absent: 'We have not detected any data loss.',
            standing: 'We have not detected the data loss root cause.',
        },
        {
            rationale: 'observation verb in object position, contracted',
            absent: "We haven't detected a production outage.",
            standing: "We haven't detected the production outage root cause.",
        },
        {
            rationale: 'negative-polarity adverb closes the object; a bare noun continues it',
            absent: 'We have not seen data loss anywhere.',
            standing: 'We have not seen the data loss root cause.',
        },
        {
            rationale: '"anywhere" after a bare object, versus a compound the incident modifies',
            absent: 'We have not found data loss anywhere.',
            standing: 'We have not found the data loss mitigation plan.',
        },
        {
            rationale: '-ly adverb closes the object; "postmortem" heads a different phrase',
            absent: 'We have not seen a production outage recently.',
            standing: 'We have not seen the production outage postmortem.',
        },
        {
            rationale: '"so far" closes the object; "blast radius" heads a different phrase',
            absent: 'We have not seen any data loss so far.',
            standing: 'We have not observed the data loss blast radius.',
        },
        {
            rationale: '"at all" closes the object; "exploit path" heads a different phrase',
            absent: 'We have not observed any data loss at all.',
            standing: 'We have not detected the security vulnerability exploit path.',
        },
    ];
    const observedAbsenceContrastCases = observedAbsenceVersusStandingIncidentContrasts.flatMap(
        ({ absent, standing }) => [
            { content: absent, priority: TicketPriority.HIGH },
            { content: standing, priority: TicketPriority.CRITICAL },
        ],
    );

    // Adverbs in subject position reach the guard through the other suffix
    // arm, which matches on the verb and never inspects what follows it. These
    // rows hold that arm still while the object arm is being narrowed.
    const observedAbsenceSubjectAdverbCases = [
        { content: 'Data loss has not occurred anywhere.', priority: TicketPriority.HIGH },
        {
            content: 'A production outage has not been reported recently.',
            priority: TicketPriority.HIGH,
        },
        { content: 'Data loss has not happened at all.', priority: TicketPriority.HIGH },
        { content: 'Data loss has not been detected yet.', priority: TicketPriority.HIGH },
    ];

    // An incident term can appear in a clause that reports no incident at all,
    // in two shapes under one contract. A planned action spells the outage
    // phrase as a verb-object-particle frame, where `down` belongs to the verb
    // rather than being predicated of the service ("we will take production
    // down"); and a compound noun can put the term in modifier position under a
    // head that names the tooling aimed at that incident class ("security
    // vulnerability scanning"). Neither asserts an occurrence, so neither may
    // raise the irreversible CRITICAL floor.
    //
    // Each row is paired with the nearest wording that does report, and the
    // pair is asserted below not to collapse. That direction is the one this
    // class has failed before: a narrowing must not be paid for by muting a
    // real report, because the floor never downgrades afterwards.
    const plannedTakedownVersusOutageContrasts = [
        {
            rationale: 'modal + bare verb; the finite past of the same verb reports an outage',
            nonReport: 'We will take production down for scheduled maintenance tonight.',
            report: 'The deploy took production down.',
        },
        {
            rationale: 'infinitival `to` under a volitional matrix verb',
            nonReport: 'We need to scale production down to save costs.',
            report: 'Production is down.',
        },
        {
            rationale: 'plan-to frame; the finite past of the same verb reports an outage',
            nonReport: 'We plan to bring production down during the maintenance window.',
            report: 'The migration brought production down.',
        },
        {
            rationale: 'modal over the `production service` spelling, with a determiner',
            nonReport: 'We should shut the production service down before the migration.',
            report: 'Our production service is completely down.',
        },
        {
            rationale: 'bare infinitive after `says to`, against the copula-less headline report',
            nonReport: 'The runbook says to spin production down first.',
            report: 'Production down.',
        },
        {
            rationale: 'modal over the `production environment` spelling',
            nonReport: 'We could power the production environment down overnight.',
            report: 'PRODUCTION DOWN: every request fails.',
        },
    ];
    const incidentToolingVersusReportContrasts = [
        {
            rationale: 'a CI capability, not a vulnerability that was found',
            nonReport: 'We added security vulnerability scanning to CI.',
            report: 'A security vulnerability was found.',
        },
        {
            rationale: 'detection capability, not detected data loss',
            nonReport: 'We added data loss detection to the pipeline.',
            report: 'We have data loss across three tenants.',
        },
        {
            rationale: 'a rehearsal, not an outage',
            nonReport: 'The team owns production outage drills.',
            report: 'We had a production outage this morning.',
        },
        {
            rationale: 'an instrument, not a finding',
            nonReport: 'Security vulnerability scanners run nightly.',
            report: 'Security vulnerabilities were found.',
        },
        {
            rationale: 'a shipped feature, not an incident',
            nonReport: 'We shipped data loss protection last quarter.',
            report: 'Customers report data-loss after upgrading the runtime.',
        },
        {
            rationale: 'a practice, not an incident',
            nonReport: 'Security vulnerability training is mandatory.',
            report: 'Security vulnerabilities were found during the rollout.',
        },
    ];
    // Adjacency alone must not cancel a mention. A head that presupposes an
    // instance refers back to an incident that happened, so it leaves that
    // incident standing however closely it follows the term. The `postmortem`,
    // `root cause`, `mitigation plan` and `exploit path` spellings are already
    // pinned by observedAbsenceVersusStandingIncidentContrasts above; this row
    // adds the one head that is itself a reporting noun.
    const incidentPresupposingHeadControls = [
        'We are still triaging the security vulnerability report from a customer.',
    ];
    // A deliberate action is not a hypothetical one. The infinitival arm of the
    // takedown frame above is justified by the verb being bare - a bare verb
    // asserts no occurrence - and that reasoning only holds while nothing above
    // the `to` supplies the assertion. A matrix that entails its complement
    // happened does supply it: "we had to take production down" reports a
    // takedown that occurred, and the downtime it reports is as real as any
    // other. Choosing the downtime does not make it hypothetical.
    //
    // Each row is paired with the already-pinned planned spelling of the same
    // frame, so the two readings of `to` cannot be satisfied by collapsing onto
    // one priority - the direction this class fails in.
    const completedTakedownVersusPlannedContrasts = [
        {
            rationale: 'past `had to` against the present `need to`, which is still a plan',
            report: 'We had to take production down after the incident.',
            planned: 'We need to scale production down to save costs.',
        },
        {
            rationale: 'past passive `were forced to` against the modal `will`',
            report: 'We were forced to take production down after the incident.',
            planned: 'We will take production down for scheduled maintenance tonight.',
        },
        {
            rationale: 'present perfect `have had to` over a recurring count',
            report: 'We have had to take production down twice this month.',
            planned: 'We plan to bring production down during the maintenance window.',
        },
        {
            rationale: '`managed to` entails the takedown happened',
            report: 'We managed to spin the production service down before the leak spread.',
            planned: 'The runbook says to spin production down first.',
        },
    ];
    // The adverb slot the frame already admits belongs to the completed reading
    // too, so the guard cannot be escaped by inserting one.
    const completedTakedownAdverbControls = ['We had to quickly take production down.'];
    // The exemption on the infinitival arm is carried by the matrix above the
    // `to`, never by the `to` itself: "we plan to" leaves the takedown
    // uncommitted, and that is the whole reason the clause reports nothing. A
    // matrix the frame does not name therefore has no claim on the exemption,
    // and the clause must keep the irreversible floor it has at the base rather
    // than inherit a reading from the two characters it shares.
    //
    // These two spellings are ordinary outage reports that say how long
    // production was down. Both are periphrastic - the implicature sits in
    // "ended up" and in "no choice", not in a single matrix verb - so no list
    // of completed matrices reaches them, and only the direction of the frame
    // decides them. Each is paired with a listed planned frame so the pair
    // cannot be satisfied by collapsing onto one priority.
    const unlistedTakedownMatrixVersusPlannedContrasts = [
        {
            rationale: '`ended up having to` - periphrastic, and the downtime is stated',
            report: 'We ended up having to take production down for three hours last night.',
            planned: 'We needed to take production down next week.',
        },
        {
            rationale: '`had no choice but to` - no matrix verb governs the `to` at all',
            report: 'We had no choice but to take production down for two hours this morning.',
            planned: 'We decided to take production down during the freeze.',
        },
    ];
    // The matrices that do not entail occurrence, held at HIGH. Each is a
    // matrix a reader might expect to pattern with `had to` but which passes
    // the cancellation test: "we needed to take production down but could not
    // get approval" is coherent, where "we had to take production down but
    // could not get approval" is not. `have to`/`are forced to` are the present
    // tense of two implicative spellings and are prospective obligations, so
    // tense alone decides them; the conditional row must keep reaching the
    // protasis guard rather than this one.
    const prospectiveTakedownMatrixControls = [
        'We needed to take production down next week.',
        'We decided to take production down during the freeze.',
        'We tried to take production down but the runbook failed.',
        'We are forced to take production down tonight.',
        'We will have to take production down tonight.',
        'If we had to take production down, the team would notice.',
    ];
    const mentionWithoutReportingRoleContrasts = [
        ...plannedTakedownVersusOutageContrasts,
        ...incidentToolingVersusReportContrasts,
    ];
    const mentionWithoutReportingRoleCases = [
        ...mentionWithoutReportingRoleContrasts.flatMap(({ nonReport, report }) => [
            { content: nonReport, priority: TicketPriority.HIGH },
            { content: report, priority: TicketPriority.CRITICAL },
        ]),
        ...incidentPresupposingHeadControls.map((content) => ({
            content,
            priority: TicketPriority.CRITICAL,
        })),
        // Only the reporting side is restated here: every `planned` row above is
        // already pinned at HIGH by mentionWithoutReportingRoleContrasts.
        ...completedTakedownVersusPlannedContrasts.map(({ report }) => ({
            content: report,
            priority: TicketPriority.CRITICAL,
        })),
        ...completedTakedownAdverbControls.map((content) => ({
            content,
            priority: TicketPriority.CRITICAL,
        })),
        // Same restatement rule: every `planned` row here is a
        // prospectiveTakedownMatrixControls row, already pinned at HIGH below.
        ...unlistedTakedownMatrixVersusPlannedContrasts.map(({ report }) => ({
            content: report,
            priority: TicketPriority.CRITICAL,
        })),
        ...prospectiveTakedownMatrixControls.map((content) => ({
            content,
            priority: TicketPriority.HIGH,
        })),
    ];

    // Round-13 convergence lever L3 (audit class C3), conditional half
    // (R13-AI-A07). An incident named inside a conditional protasis is
    // hypothesised, not reported, so it must not raise the irreversible
    // CRITICAL floor. The protasis may lead ("If data loss occurs, …") or
    // trail ("… if data loss occurs"), and the main clause may be a question,
    // a declarative or an imperative - the cause is subordination, not
    // question scope, so all three shapes belong in one table.
    const conditionalProtasisCases = [
        // Leading protasis, interrogative main clause.
        'If data loss occurs, how do I recover?',
        'If a security vulnerability is found, what is the process?',
        // Leading protasis, declarative main clause: no question anywhere.
        'If data loss occurs, we page the on-call engineer.',
        'Unless data loss occurs, we stay on the current plan.',
        'If production is down, we roll back.',
        'Unless a production outage occurs, we ship on Friday.',
        'Unless a security vulnerability is found, we ship on Friday.',
        // Leading protasis, imperative main clause: no clause boundary is
        // produced at all, so the whole sentence is scored as one clause.
        'If data loss occurs, escalate to the on-call engineer.',
        'In the event of data loss, restore from backup.',
        // The remaining irrealis subordinators, leading.
        'Whenever data loss occurs, we page the on-call engineer.',
        'Provided that data loss occurs, we restore from backup.',
        'In the event that data loss occurs, restore from backup.',
        'In case data loss occurs, we restore from backup.',
        // Trailing protasis: same subordination, no boundary token involved.
        'We restore from backup if data loss occurs.',
        'We stay on the current plan unless data loss occurs.',
        'We page the on-call engineer whenever data loss occurs.',
        'Keep the snapshot in case data loss occurs.',
        'Restore from backup in case of data loss.',
        'Check if data loss occurred.',
        'Let me know if this is a security vulnerability.',
    ];

    // Conditionals the reviewed implementation already passed, but only by
    // accident - `when` and `should` collide with `questionWords`/`auxiliaries`
    // and "in case of" has no declarative predicate for the coordination guard
    // to trip over. They are pinned so the explicit conditional handling cannot
    // buy `if`/`unless` at their expense.
    const conditionalProtasisRegressionPins = [
        'If data loss occurs how do I recover?',
        'When a production outage occurs, who do I page?',
        'Should data loss occur, how do we restore?',
        'Should data loss occur, escalate to the on-call engineer.',
        'In case of data loss, what is the runbook?',
        'How do I recover if data loss occurs?',
        'What happens if a production outage occurs, and how do I recover?',
    ];

    // The other side of the same boundary: a subordinator-shaped word that is
    // not opening a conditional protasis over the incident must leave the
    // incident affirmed. These are the sentences a careless widening would
    // silently mute, so each names the reason it stays CRITICAL.
    const nonConditionalSubordinatorControls = [
        {
            rationale: 'plain modal `should`, not the inverted conditional',
            content: 'We should fix data loss in production.',
        },
        {
            rationale: '`provided` as a lexical verb, not the `provided that` subordinator',
            content: 'We provided data loss reports to customers.',
        },
        {
            rationale: '`when` is temporal here and reports a past event, not a hypothesis',
            content: 'We paged the on-call engineer when data loss occurred.',
        },
        {
            rationale: '`when` again: the factual reading is the only one available',
            content: 'Customers lost access when the production outage occurred.',
        },
        {
            rationale: '`once` is temporal, not irrealis, and reports a past event',
            content: 'Once data loss occurred, we restored from backup.',
        },
        {
            rationale: 'the incident is asserted before the subordinator opens',
            content: 'Data loss occurred if you look at the logs.',
        },
        {
            rationale: 'the incident is in the apodosis, outside the protasis',
            content: 'If you ask, data loss occurred.',
        },
        {
            rationale: 'a sentence break closes the protasis before the incident',
            content: 'Ask me if you can. Data loss occurred.',
        },
        {
            rationale: 'a semicolon closes the protasis before the incident',
            content: 'Tell me if you like; data loss occurred.',
        },
        {
            rationale: 'the protasis ends at its comma; the incident follows it',
            content: 'If you look at the dashboard, data loss is at forty percent.',
        },
        {
            rationale:
                'consequent of a conditional: deliberately out of scope, pinned so a later widening is a decision',
            content: 'If the backup fails, data loss occurs.',
        },
    ];

    // Separator half of the same lever. `clauseBoundary` emits five linguistic
    // classes and only the list-forming ones license the shared-subject reading
    // in which a later negation scopes back over an earlier bare incident
    // mention. This is asserted as behaviour on both sides of the line, not as
    // agreement between two private token sets: adding an adversative or a
    // subordinator to the boundary alternation must not quietly join the
    // coordination guard, and must not fail this table for the wrong reason.
    const listFormingSeparators = [
        { token: ',', content: 'Data loss, production outages have not been reported.' },
        { token: 'and', content: 'Data loss and production outages have not been reported.' },
        { token: 'or', content: 'Data loss or production outages have not been reported.' },
    ];
    const nonListFormingSeparators = [
        {
            token: 'yet',
            kind: 'adversative coordinator',
            content: 'Data loss yet production outages have not been reported.',
        },
        {
            token: ', yet',
            kind: 'adversative coordinator, comma spelling',
            content: 'Data loss, yet production outages have not been reported.',
        },
        {
            token: ', but',
            kind: 'adversative coordinator',
            content: 'Data loss, but production outages have not been reported.',
        },
        {
            token: 'however',
            kind: 'adversative adverb after a sentence break',
            content: 'Data loss occurred. However, production outages have not been reported.',
        },
        {
            token: 'because',
            kind: 'subordinator',
            content: 'Data loss because production outages have not been reported.',
        },
        {
            token: ':',
            kind: 'expository punctuation',
            content: 'Data loss: production outages have not been reported.',
        },
        {
            token: '.',
            kind: 'sentence break',
            content: 'Data loss. Production outages have not been reported.',
        },
        {
            token: ';',
            kind: 'sentence break',
            content: 'Data loss; production outages have not been reported.',
        },
    ];

    // Affirmative contrast and exposition: an incident is affirmed and then
    // contrasted with the absence of a *different* one. Green before the
    // conditional change and required to stay green, so conditional symmetry
    // cannot be bought by folding adversatives or colons into shared-subject
    // grammar.
    const affirmativeContrastControls = [
        {
            content: 'Data loss occurred, yet production outages have not been reported.',
            priority: TicketPriority.CRITICAL,
        },
        {
            content: 'We hit data loss, but production outages have not been reported.',
            priority: TicketPriority.CRITICAL,
        },
        {
            content: 'Data loss occurred. However, production outages have not been reported.',
            priority: TicketPriority.CRITICAL,
        },
        {
            content: 'Incident summary: data loss affected twelve tenants.',
            priority: TicketPriority.CRITICAL,
        },
        {
            content: 'Status: data loss has not been reported.',
            priority: TicketPriority.HIGH,
        },
    ];

    const conditionalScopeCases = [
        ...conditionalProtasisCases.map((content) => ({
            content,
            priority: TicketPriority.HIGH,
        })),
        ...conditionalProtasisRegressionPins.map((content) => ({
            content,
            priority: TicketPriority.HIGH,
        })),
        ...nonConditionalSubordinatorControls.map(({ content }) => ({
            content,
            priority: TicketPriority.CRITICAL,
        })),
    ];
    const separatorClassCases = [
        ...listFormingSeparators.map(({ content }) => ({
            content,
            priority: TicketPriority.HIGH,
        })),
        ...nonListFormingSeparators.map(({ content }) => ({
            content,
            priority: TicketPriority.CRITICAL,
        })),
        ...affirmativeContrastControls,
    ];

    describe.each(['heuristic', 'model failure', 'healthy LOW model'] as const)(
        '%s',
        (boundary) => {
            const checkPriority = async ({ content, priority }: (typeof cases)[number]) => {
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
            };
            it.each(cases)('$priority: $content', checkPriority);
            describe('shared predicate scope preservation', () => {
                it.each(sharedPredicateScopeCases)('$priority: $content', checkPriority);
            });
            describe('incident polarity contrasts', () => {
                it.each(polarityContrastCases)('$priority: $content', checkPriority);
            });
            describe('incident absence versus unresolved remediation', () => {
                it.each(incidentAbsenceContrastCases)('$priority: $content', checkPriority);
            });
            describe('observed absence versus a standing incident', () => {
                it.each(observedAbsenceContrastCases)('$priority: $content', checkPriority);
                it.each(observedAbsenceSubjectAdverbCases)('$priority: $content', checkPriority);
            });
            describe('incident mention without a reporting role', () => {
                it.each(mentionWithoutReportingRoleCases)('$priority: $content', checkPriority);
            });
            describe('conditional protasis versus assertion', () => {
                it.each(conditionalScopeCases)('$priority: $content', checkPriority);
            });
            describe('clause separator classes', () => {
                it.each(separatorClassCases)('$priority: $content', checkPriority);
            });
        },
    );

    // The same relation for the mention-without-a-reporting-role rows: a
    // planned takedown or a tooling compound must never land on the priority of
    // the report it borrows its vocabulary from. A widening that buys one
    // spelling by collapsing the pair fails here even if both rows move
    // together.
    describe('incident mention without a reporting role', () => {
        it.each(mentionWithoutReportingRoleContrasts)(
            'does not collapse "$nonReport" into "$report" ($rationale)',
            ({ nonReport, report }) => {
                const classifier = new TicketClassifier({
                    provider: 'anthropic',
                    apiKey: 'test-key',
                    baseURL: aimock().url,
                });
                expect(classifier.heuristicClassify(nonReport).priority).not.toBe(
                    classifier.heuristicClassify(report).priority,
                );
            },
        );

        // The same relation for the two readings of the infinitival `to`. A
        // narrowing that keeps the planned spelling free of the floor by also
        // freeing the completed one, or that restores the completed one by
        // re-pinning every plan, fails here even though each direction on its
        // own could be made to look correct.
        it.each([
            ...completedTakedownVersusPlannedContrasts,
            ...unlistedTakedownMatrixVersusPlannedContrasts,
        ])('does not collapse "$report" into "$planned" ($rationale)', ({ report, planned }) => {
            const classifier = new TicketClassifier({
                provider: 'anthropic',
                apiKey: 'test-key',
                baseURL: aimock().url,
            });
            expect(classifier.heuristicClassify(report).priority).not.toBe(
                classifier.heuristicClassify(planned).priority,
            );
        });
    });

    // Stated once as a relation, so a fix cannot satisfy the rows above by
    // moving both sides together. A hypothesised incident and the same incident
    // asserted in the main clause must not land on one priority.
    describe('conditional protasis versus assertion', () => {
        const hypothesisedVersusAsserted = [
            {
                rationale: 'leading protasis against the same runbook stated as a report',
                hypothesised: 'If data loss occurs, we page the on-call engineer.',
                asserted: 'Data loss occurred, we paged the on-call engineer.',
            },
            {
                rationale: 'trailing protasis against the same clause asserted',
                hypothesised: 'We restore from backup if data loss occurs.',
                asserted: 'We restore from backup because data loss occurred.',
            },
            {
                rationale: 'negative conditional against a plain report',
                hypothesised: 'Unless data loss occurs, we stay on the current plan.',
                asserted: 'Data loss occurred, so we left the current plan.',
            },
        ];
        it.each(hypothesisedVersusAsserted)(
            'does not collapse "$hypothesised" into "$asserted" ($rationale)',
            ({ hypothesised, asserted }) => {
                const classifier = new TicketClassifier({
                    provider: 'anthropic',
                    apiKey: 'test-key',
                    baseURL: aimock().url,
                });
                expect(classifier.heuristicClassify(hypothesised).priority).not.toBe(
                    classifier.heuristicClassify(asserted).priority,
                );
            },
        );
    });

    // The separator relation, likewise stated once. Only a list-forming
    // coordinator lets a later negation reach back over a bare incident
    // mention; every other boundary class leaves that mention affirmed.
    describe('clause separator classes', () => {
        it.each(
            nonListFormingSeparators.flatMap((nonListForming) =>
                listFormingSeparators.map((listForming) => ({ nonListForming, listForming })),
            ),
        )(
            '"$nonListForming.token" ($nonListForming.kind) does not read like the "$listForming.token" list',
            ({ nonListForming, listForming }) => {
                const classifier = new TicketClassifier({
                    provider: 'anthropic',
                    apiKey: 'test-key',
                    baseURL: aimock().url,
                });
                expect(classifier.heuristicClassify(nonListForming.content).priority).not.toBe(
                    classifier.heuristicClassify(listForming.content).priority,
                );
            },
        );
    });

    // The relation itself, stated once: a negated remediation verb, property or
    // foreign object must never land on the same priority as the absence
    // statement it resembles. A future widening that buys one spelling by
    // collapsing the pair fails here even if both rows are edited together.
    describe('incident absence versus unresolved remediation', () => {
        it.each(incidentAbsenceVersusRemediationContrasts)(
            'does not collapse "$unresolved" into "$absent" ($rationale)',
            ({ unresolved, absent }) => {
                const classifier = new TicketClassifier({
                    provider: 'anthropic',
                    apiKey: 'test-key',
                    baseURL: aimock().url,
                });
                expect(classifier.heuristicClassify(unresolved).priority).not.toBe(
                    classifier.heuristicClassify(absent).priority,
                );
            },
        );
    });

    // Same relation from the absence side: narrowing the guard must not be paid
    // for by promoting an ordinary absence report to the irreversible floor.
    describe('observed absence versus a standing incident', () => {
        it.each(observedAbsenceVersusStandingIncidentContrasts)(
            'does not collapse "$absent" into "$standing" ($rationale)',
            ({ absent, standing }) => {
                const classifier = new TicketClassifier({
                    provider: 'anthropic',
                    apiKey: 'test-key',
                    baseURL: aimock().url,
                });
                expect(classifier.heuristicClassify(absent).priority).not.toBe(
                    classifier.heuristicClassify(standing).priority,
                );
            },
        );
    });
});

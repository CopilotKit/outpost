import { z } from 'zod';
import { AuxiliaryModel, auxiliaryErrorUsage } from './auxiliary-model.js';
import type { AuxiliaryModelOptions } from './auxiliary-model.js';
import type { TicketClassification, TokenUsage } from './types.js';
import { TicketPriority, TicketType } from './types.js';
import { config } from './config.js';

const CLASSIFIER_SYSTEM_PROMPT = `You are a support ticket classifier for CopilotKit, an open-source AI framework. Classify the ticket and respond with ONLY a JSON object (no markdown, no explanation):

{
  "priority": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "type": "BUG" | "FEATURE_REQUEST" | "QUESTION" | "INTEGRATION_HELP" | "ACCOUNT_ISSUE" | "OTHER",
  "tags": ["tag1", "tag2"],
  "reasoning": "<one sentence>"
}

Classification guidelines:
- **CRITICAL priority**: Security vulnerabilities, data loss, production outages
- **HIGH priority**: Error messages, crashes, production issues, security concerns
- **MEDIUM priority**: Bugs in non-critical flows, integration problems, performance issues
- **LOW priority**: Feature requests, how-to questions, general inquiries, documentation questions

- **BUG type**: Bug reports, error reports, things that are broken or not working as expected
- **FEATURE_REQUEST type**: Feature requests, enhancement suggestions, new capability requests
- **QUESTION type**: General questions, how-to questions, setup help, configuration questions, conceptual inquiries, documentation questions
- **INTEGRATION_HELP type**: Integration problems, setup help with third-party tools
- **ACCOUNT_ISSUE type**: Account/billing problems, access issues
- **OTHER type**: Anything that doesn't fit the above categories

Tags should be specific CopilitKit concepts when relevant: "copilotkit-runtime", "coagent", "copilot-textarea", "react-ui", "cloud", "self-hosted", "actions", "hooks", "integration", "authentication", "deployment", "performance", "typescript", "next.js", "langchain", "langgraph", "crewai", "ag2"`;

/**
 * Ticket classifier that combines fast heuristics with model-powered
 * classification for nuanced categorization.
 *
 * Uses heuristics first for quick wins (error messages, obvious patterns),
 * then refines with Luna when heuristics are insufficient.
 */
export class TicketClassifier {
    private readonly model: AuxiliaryModel;

    constructor(options?: AuxiliaryModelOptions) {
        this.model = new AuxiliaryModel(config.classifierModel, options);
    }

    /**
     * Classify a ticket based on its content.
     * Applies heuristics first, then refines with the configured model.
     */
    async classify(
        content: string,
    ): Promise<TicketClassification & { tokenUsage: TokenUsage; degraded: boolean }> {
        // Apply heuristics for fast pre-classification
        const heuristic = this.heuristicClassify(content);

        try {
            const { output: parsed, tokenUsage } = await this.model.run({
                name: 'Outpost ticket classification',
                instructions: CLASSIFIER_SYSTEM_PROMPT,
                input: content.slice(0, 3000),
                schema: z.object({
                    priority: z.enum(TicketPriority),
                    type: z.enum(TicketType),
                    tags: z.array(z.string()),
                    reasoning: z.string().min(1),
                }),
                maxTokens: config.maxClassifierTokens,
                temperature: config.classifierTemperature,
            });

            // Heuristics provide an urgency floor, never downgrade CRITICAL.
            const finalPriority =
                heuristic.priority === TicketPriority.CRITICAL
                    ? TicketPriority.CRITICAL
                    : heuristic.priority === TicketPriority.HIGH &&
                        parsed.priority !== TicketPriority.CRITICAL
                      ? TicketPriority.HIGH
                      : parsed.priority;

            // Merge tags from both sources, deduplicate
            const allTags = [...new Set([...heuristic.tags, ...parsed.tags])];

            return {
                priority: finalPriority,
                type: parsed.type,
                tags: allTags,
                reasoning: parsed.reasoning,
                tokenUsage,
                degraded: false,
            };
        } catch (error) {
            console.error(
                `[Classifier] Classification failed, falling back to heuristics:`,
                error instanceof Error ? error.message : 'Unknown error',
            );
            return {
                ...heuristic,
                tokenUsage: auxiliaryErrorUsage(error),
                degraded: true,
            };
        }
    }

    /**
     * Fast heuristic classification based on keyword patterns.
     */
    heuristicClassify(content: string): TicketClassification {
        const lower = content.toLowerCase();
        const tags: string[] = [];

        // Priority detection
        let priority = TicketPriority.MEDIUM;

        // Critical phrases still need context: a prevention question or negated report
        // must not create a CRITICAL floor. These conservative guards cover common
        // phrasing, not full language inference, and apply to each incident clause.
        const criticalPriorityPatterns = [
            /\bsecurity\s+vulnerabilit(?:y|ies)\b/i,
            /\bdata[\s-]+loss\b/i,
            /\bproduction[\s-]+outages?\b/i,
            /\bproduction(?:\s+(?:service|system|environment))?\s+(?:is\s+)?down\b/i,
        ];
        const auxiliaries =
            '(?:can|could|should|would|will|is|are|was|were|do|does|did|has|have|had)';
        const questionWords = `(?:how|what|why|when|where|${auxiliaries})`;
        const questionStart = new RegExp(`^\\s*${questionWords}\\b`, 'i');
        const nonIncidentPrefix =
            /\b(?:prevent(?:s|ed|ing)?|avoid(?:s|ed|ing)?|hypothetical|no|not|never|without|\w+n['’]t)\b/i;
        const incidentMention = `(?:${criticalPriorityPatterns.map((p) => p.source).join('|')})`;
        const coordination = '(?:,\\s*(?:(?:and|or)\\s+)?|\\s+(?:and|or)\\s+)';
        const remainingIncidentList = `(?:${coordination}(?:(?:a|an)\\s+)?${incidentMention})*`;
        const nonIncidentSuffix = new RegExp(
            `^${remainingIncidentList}\\s+(?:prevention\\b|(?:(?:(?:is|are|was|were)|(?:has|have|had)\\s+been)\\s+)?(?:avoided|prevented)\\b|(?:${auxiliaries}\\s+)*(?:not|never|\\w+n['’]t)\\b)`,
            'i',
        );
        // Retain punctuation, and separate independent clauses rather than
        // treating a greeting, question, or negation as sentence-wide context.
        // Coordinated noun lists keep their shared question/negation scope;
        // "and data loss occurred" starts a new assertion, "and data loss" does not.
        const declarativeVerbs =
            '(?:is|are|was|were|has|have|had|occur(?:s|red)?|happen(?:s|ed)?|cause[sd]?|finds?|found|report(?:s|ed)?)';
        const declarativePredicate = new RegExp(`\\b${declarativeVerbs}\\b`, 'i');
        const incidentSubject =
            '(?:(?:a|an|our|the)\\s+)?(?:data[\\s-]+loss|production[\\s-]+outages?|security\\s+vulnerabilit(?:y|ies)|production(?:\\s+(?:service|system|environment))?)';
        const independentClauseStart = `(?:${questionWords}\\b|(?:we|they|i|you|it|there|customers|users)\\s+\\w+|${incidentSubject}\\s+${declarativeVerbs}\\b)`;
        const clauseBoundary = new RegExp(
            `(?<=[.!?\\n;])|\\b(?:but|however|because)\\b|(?:[:,]|\\b(?:and|or|yet)\\b)(?=\\s*${independentClauseStart})`,
            'gi',
        );
        const clauses: string[] = [];
        let clauseStart = 0;
        for (const boundary of content.matchAll(clauseBoundary)) {
            const preceding = content.slice(clauseStart, boundary.index);
            // "Data loss and production outages have not occurred" shares one predicate.
            // Do not turn the first subject into a standalone affirmative report.
            if (
                /^(?:and|or)$/i.test(boundary[0]) &&
                criticalPriorityPatterns.some((pattern) => pattern.test(preceding)) &&
                !declarativePredicate.test(preceding) &&
                !questionStart.test(preceding)
            )
                continue;
            clauses.push(preceding);
            clauseStart = boundary.index + boundary[0].length;
        }
        clauses.push(content.slice(clauseStart));
        let earlierQuestion = false;
        const hasCriticalIncident = clauses.some((clause) => {
            const startsQuestion = questionStart.test(clause);
            // In "Can you help because production is down?", the final question
            // mark belongs to the help request; the declarative clause reports
            // the incident. A bare "Production is down?" remains a question.
            const hasDeclarativePredicate = declarativePredicate.test(clause);
            const isQuestion =
                startsQuestion ||
                (clause.includes('?') && (!earlierQuestion || !hasDeclarativePredicate));
            earlierQuestion = /[.!?\n]/.test(clause) ? false : earlierQuestion || startsQuestion;
            if (isQuestion) return false;

            return criticalPriorityPatterns.some((pattern) => {
                const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
                const globalPattern = new RegExp(pattern.source, flags);
                for (const match of clause.matchAll(globalPattern)) {
                    const prefix = clause.slice(0, match.index);
                    const suffix = clause.slice(match.index + match[0].length);
                    if (!nonIncidentPrefix.test(prefix) && !nonIncidentSuffix.test(suffix)) {
                        return true;
                    }
                }
                return false;
            });
        });

        const highPriorityPatterns = [
            /error:/i,
            /exception/i,
            /crash/i,
            /fatal/i,
            /broken/i,
            /not working/i,
            /fails?/i,
            /bug/i,
            /production/i,
            /urgent/i,
            /critical/i,
            /security/i,
            /data loss/i,
            /typeerror/i,
            /referenceerror/i,
            /syntaxerror/i,
            /cannot read prop/i,
            /undefined is not/i,
            /500\s*(error|internal)/i,
            /502|503|504/i,
        ];

        const lowPriorityPatterns = [
            /how (do|can|to)/i,
            /is (it|there) (a way|possible)/i,
            /feature request/i,
            /would be nice/i,
            /suggestion/i,
            /documentation/i,
            /example/i,
            /tutorial/i,
            /what is/i,
            /explain/i,
            /difference between/i,
        ];

        if (hasCriticalIncident) {
            priority = TicketPriority.CRITICAL;
        } else if (highPriorityPatterns.some((p) => p.test(content))) {
            priority = TicketPriority.HIGH;
        } else if (lowPriorityPatterns.some((p) => p.test(content))) {
            priority = TicketPriority.LOW;
        }

        // Type detection
        let type = TicketType.OTHER;
        const issuePatterns = [
            /error/i,
            /bug/i,
            /crash/i,
            /broken/i,
            /not working/i,
            /fail/i,
            /issue/i,
            /problem/i,
            /wrong/i,
        ];
        const questionPatterns = [
            /how (do|can|to)/i,
            /what is/i,
            /explain/i,
            /difference between/i,
            /is (it|there) (a way|possible)/i,
            /documentation/i,
            /example/i,
            /tutorial/i,
            /setup help/i,
            /configur/i,
        ];
        const featurePatterns = [
            /feature request/i,
            /would be nice/i,
            /suggestion/i,
            /enhancement/i,
            /new (feature|capability)/i,
            /please add/i,
        ];
        if (issuePatterns.some((p) => p.test(content))) {
            type = TicketType.BUG;
        } else if (questionPatterns.some((p) => p.test(content))) {
            type = TicketType.QUESTION;
        } else if (featurePatterns.some((p) => p.test(content))) {
            type = TicketType.FEATURE_REQUEST;
        }

        // Tag detection for CopilotKit concepts
        const tagPatterns: Array<[RegExp, string]> = [
            [/copilotkit[-\s]?runtime/i, 'copilotkit-runtime'],
            [/coagent/i, 'coagent'],
            [/copilot[-\s]?textarea/i, 'copilot-textarea'],
            [/react[-\s]?ui|CopilotChat|CopilotPopup|CopilotSidebar/i, 'react-ui'],
            [/cloud/i, 'cloud'],
            [/self[-\s]?host/i, 'self-hosted'],
            [/action|useCopilotAction/i, 'actions'],
            [/hook|useCopilot/i, 'hooks'],
            [/integrat/i, 'integration'],
            [/auth/i, 'authentication'],
            [/deploy/i, 'deployment'],
            [/performa|slow|latency/i, 'performance'],
            [/typescript|\btsx?\b/i, 'typescript'],
            [/next\.?js|nextjs/i, 'next.js'],
            [/langchain/i, 'langchain'],
            [/langgraph/i, 'langgraph'],
            [/crewai/i, 'crewai'],
            [/ag-?ui/i, 'ag-ui'],
        ];

        for (const [pattern, tag] of tagPatterns) {
            if (pattern.test(lower)) {
                tags.push(tag);
            }
        }

        return {
            priority,
            type,
            tags,
            reasoning: `Heuristic classification: ${priority} priority ${type.toLowerCase().replace('_', ' ')}`,
        };
    }
}

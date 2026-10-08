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
            /\bproduction(?:\s+(?:service|system|environment))?\s+(?:(?:is|are|was|were)\s+(?:(?:currently|completely|still)\s+)*)?down\b/i,
        ];
        const auxiliaries =
            '(?:can|could|should|would|will|is|are|was|were|do|does|did|has|have|had)';
        const questionWords = `(?:how|what|why|when|where|${auxiliaries})`;
        const questionStart = new RegExp(`^\\s*${questionWords}\\b`, 'i');
        const causalDiagnosticQuestionStart =
            /^\s*(?:(?:can|could)\s+(?:this|it|that)\s+be|is\s+(?:this|it|that)|did\s+(?:(?:this|it|that)\s+happen|(?:[a-z]+\s+){1,5}(?:happen|fail)))\b/i;
        const incidentMention = `(?:${criticalPriorityPatterns.map((p) => p.source).join('|')})`;
        const coordination = '(?:,\\s*(?:(?:and|or)\\s+)?|\\s+(?:and|or)\\s+)';
        const remainingIncidentList = `(?:${coordination}(?:(?:a|an)\\s+)?${incidentMention})*`;
        const failedPreventionPrefix =
            /\b(?:failed\s+to\s+|(?:(?:can|could|should|would|will|is|are|was|were|do|does|did|has|have|had)\s+(?:not|never)|\w+n['’]t)\s+)(?:prevent|avoid)\s+(?:a|an|the)?\s*$/i;
        const successfulPreventionPrefix =
            /\b(?:prevent(?:s|ed|ing)?|avoid(?:s|ed|ing)?)\s+(?:a|an|the)?\s*$/i;
        const withoutIncidentPrefix =
            /\bwithout(?:\s+(?:any|reported|evidence|of|reports?|customer|customers))*\s+(?:a|an|the)?\s*$/i;
        const noIncidentPrefix =
            /\b(?:there\s+(?:was|were)\s+no|no(?:\s+(?:reported|customer|customers|reports?|evidence|of))*|no\s+(?:users|customers|team\s+members)\s+(?:experienced|had|saw|reported))\s+(?:a|an|the)?\s*$/i;
        const copularNegationPrefix =
            /\b(?:(?:is|are|was|were)\s+not|(?:is|are|was|were)n['’]t)\s+(?:a|an|the)?\s*$/i;
        const hypotheticalIncidentPrefix = /\bhypothetical\s+(?:a|an|the)?\s*$/i;
        const denialRelationPrefix =
            /\b(?:(?:(?:do|does|did)\s+(?:not|never)|(?:do|does|did)n['’]t)\s+(?:represent|constitute)|(?:is|are|was|were)\s+unrelated\s+to)\s+(?:a|an|the)?\s*$/i;
        // One verb class, two syntactic positions. A negation only cancels an
        // incident mention when it negates the incident's own occurrence or
        // observation; negating a remediation verb ("patched", "mitigated"),
        // a property ("recoverable") or a different object ("the root cause")
        // leaves the incident standing. Enumerate the class rather than
        // accepting any negated predicate: a verb belongs when negating it
        // asserts that the incident did not occur or was not observed, and does
        // not belong when it describes what was done *about* an incident.
        //
        // Object position: the incident is what was not observed or not caused
        // ("we have not found any data loss"), so transitive forms belong here.
        const negatedIncidentObjectVerbs =
            '(?:see|seen|observe|observed|detect|detected|find|found|receive|received|report|reported|experience|experienced|had|suffer|suffered|cause|caused|occur|occurred|happen|happened)';
        // Subject position: the incident is what did not occur or was not
        // observed ("data loss has not occurred"), so only intransitive and
        // passive forms belong here. "cause"/"caused" is object-position only:
        // "data loss was not caused by the migration" presupposes the data
        // loss, and must not cancel it.
        const negatedIncidentSubjectVerbs =
            '(?:seen|observed|detected|found|reported|experienced|suffered|occur|occurred|happen|happened)';
        // The object phrase runs to the end of the prefix as a repeated group, so
        // each gap inside it needs exactly one consumer. Where two arms of a
        // repeated group can both consume the same whitespace, the engine has a
        // free choice per gap and enumerates 2^gaps partitions before reporting a
        // failure — on ticket text this is unbounded work for an unbounded input,
        // so the discipline below is a runtime-safety property, not a style one.
        //
        // The discipline: an arm consumes the whitespace that *precedes* its own
        // token and never the whitespace that follows it. A token is never
        // whitespace, so each leading `\s+`/`\s*` is pinned to the whole gap and
        // cannot be split.
        //
        // `and`/`or` is the one arm that must still assert a following gap — it
        // may not sit at the very end of the object phrase — so it consumes a
        // single `\s` rather than `\s+`, leaving any remainder to the next arm's
        // leading run. That keeps the accepted language identical: the original
        // `\s+…\s+` needed one whitespace for itself plus whatever the next arm
        // required, which is exactly `\s` plus the next arm's leading run.
        const separatedObjectToken = `(?:yet|already|any|customer|customers|reports?|reported|evidence|of|(?:a|an|the)|${incidentMention})`;
        const negativeObservationPrefix = new RegExp(
            `\\b(?:(?:(?:has|have|had|do|does|did|was|were|is|are)\\s+(?:not|never)|\\w+n['’]t)\\s+|never\\s+)(?:yet\\s+|already\\s+|any\\s+|customer\\s+|customers\\s+|reports?\\s+|reported\\s+|evidence\\s+|of\\s+)*${negatedIncidentObjectVerbs}\\b(?:\\s+${separatedObjectToken}|\\s*[,/]|\\s+(?:and|or)\\s)*\\s*$`,
            'i',
        );
        // …and the incident has to be the head of that object, not a modifier
        // inside it. "We have not found any data loss." is an absence report;
        // "We have not found the data loss root cause." reports data loss
        // whose cause is still open. The two differ by whether a further bare
        // noun continues the object phrase, so the mention still heads it when
        // what follows cannot be part of that noun phrase at all: the clause
        // ends, or a closed-class word takes the phrase over.
        const objectPhraseEnd = '\\s*(?:[.?!,;:/]|$)';
        // Coordinators and prepositions end a noun phrase rather than
        // continuing it; "reports", "evidence" and "incidents" head an absence
        // report about the incident and are kept from the original list.
        const objectPhraseHandoff =
            '(?:and|or|nor|of|in|on|at|for|from|to|during|after|before|since|with|across|reports?|evidence|incidents?)';
        // The post-object adverb slot is the one open position here, and it is
        // narrowed by grammar rather than by listing adverbs as they turn up:
        // negative-polarity items, which only a negation licenses and whose
        // presence is therefore positive evidence that the object sits inside
        // the negation's scope, plus the -ly adverb morpheme ("recently",
        // "lately"). "so far"/"thus far" are listed because they carry the same
        // post-object reading with no -ly form. This is a slot test, not a part
        // of speech tagger: an adverb outside both still reads as a continuing
        // noun, and a noun ending in -ly still reads as an adverb.
        const postObjectAdverb =
            '(?:any(?:where|more)|any\\s+more|at\\s+all|whatsoever|either|ever|yet|so\\s+far|thus\\s+far|\\w+ly)';
        const negatedIncidentObjectHead = new RegExp(
            `^(?:${objectPhraseEnd}|\\s+(?:${objectPhraseHandoff}|${postObjectAdverb})\\b)`,
            'i',
        );
        // `no`/`without` negate a determiner phrase rather than a verb's
        // object, so the same modifier-versus-head decision reaches them from
        // the other side. A predicate legitimately follows the mention here -
        // "No data loss has been reported." is an absence report and stays
        // cancelled - so "a further bare noun continues the phrase" cannot be
        // the test the way it is above. What ends the cancellation instead is
        // the complement of `incidentToolingHeads` below: a head that
        // presupposes an instance. Naming a root cause, a postmortem or a
        // mitigation plan refers back to an incident that happened, so the
        // determiner negates that head and leaves the incident standing ("No
        // production outage postmortem has been written." reports the outage).
        //
        // Enumerated, not inferred from "some noun follows": the complement of
        // this set is every predicate these two arms must keep cancelling, so
        // an unlisted continuation keeps the absence reading. "report" and
        // "incident" are named as presupposing below but stay out of this set
        // deliberately - `objectPhraseHandoff` already reads them as heading an
        // absence report about the incident ("no data loss reports"), and
        // splitting those two readings is a separate decision.
        const incidentPresupposingHeads = '(?:root\\s+causes?|post[\\s-]?mortems?|mitigations?)';
        const incidentPresupposingHeadSuffix = new RegExp(
            `^\\s+${incidentPresupposingHeads}\\b`,
            'i',
        );
        const hasNonIncidentPrefix = (prefix: string, suffix: string): boolean =>
            !failedPreventionPrefix.test(prefix) &&
            (successfulPreventionPrefix.test(prefix) ||
                hypotheticalIncidentPrefix.test(prefix) ||
                copularNegationPrefix.test(prefix) ||
                denialRelationPrefix.test(prefix) ||
                ((withoutIncidentPrefix.test(prefix) || noIncidentPrefix.test(prefix)) &&
                    !incidentPresupposingHeadSuffix.test(suffix)) ||
                (negativeObservationPrefix.test(prefix) && negatedIncidentObjectHead.test(suffix)));
        // A negated predicate in subject position, up to but not including the
        // verb: "has not been", "did not", "hasn't", "were never yet". Shared
        // so the two suffix guards below differ only in the verb class they
        // accept, which is the whole distinction between them.
        const negatedPredicateOpener = `(?:${auxiliaries}\\s+)*(?:not|never|\\w+n['’]t)\\s+(?:been\\s+|yet\\s+|ever\\s+|already\\s+)*`;
        const failedPassivePreventionSuffix = new RegExp(
            `^${remainingIncidentList}\\s+${negatedPredicateOpener}(?:prevented|avoided)\\b`,
            'i',
        );
        const nonIncidentSuffix = new RegExp(
            `^${remainingIncidentList}\\s+(?:prevention\\b|(?:(?:(?:is|are|was|were)|(?:has|have|had)\\s+been)\\s+)(?:avoided|prevented)\\b|(?:avoided|prevented)(?:\\s+(?:by|during|before|after|through|with|via)\\b|[.?!,;:]|$)|${negatedPredicateOpener}${negatedIncidentSubjectVerbs}\\b)`,
            'i',
        );
        const affirmativeNotOnly = /\bnot\s+only\b/gi;
        // A conditional protasis hypothesises its incident rather than
        // reporting one: "If data loss occurs, we page the on-call engineer."
        // is a runbook. Subordination is the cause, not question scope, so this
        // holds whether the main clause is a question, a declarative or an
        // imperative, and whether or not a comma separates the two.
        //
        // Only irrealis subordinators are listed. Each can open a hypothesis
        // and none can open a factual past report, which is why `when` and
        // `once` are deliberately absent: "We paged the on-call engineer when
        // data loss occurred." and "Once data loss occurred, we restored from
        // backup." are reports and must stay CRITICAL, and separating their two
        // readings would need tense analysis rather than a word list. `should`
        // is only the inverted conditional, so it is anchored to the clause
        // start and cannot catch the plain modal in "We should fix data loss in
        // production."; `provided`/`providing` require `that`, which separates
        // the subordinator from the lexical verb in "We provided data loss
        // reports to customers.".
        const conditionalSubordinator =
            '(?:if|unless|whenever|in\\s+case(?:\\s+of)?|in\\s+the\\s+event\\s+(?:of|that)|provid(?:ed|ing)\\s+that)';
        // The protasis runs from its subordinator up to the first
        // clause-terminating punctuation, so an incident named past that
        // punctuation is outside it and stays affirmed: "If you ask, data loss
        // occurred." still reports data loss. An incident in the consequent of
        // a conditional is likewise untouched here.
        const conditionalProtasisPrefix = new RegExp(
            `(?:\\b${conditionalSubordinator}\\b|^\\s*should\\b)[^,;:.!?]*$`,
            'i',
        );
        // A mention is not a report. Two shapes put an incident term in a
        // clause that asserts no occurrence, and both are guarded here.
        //
        // First, the outage phrase spelled as a verb-object-particle frame.
        // "Production is down." predicates `down` of the service; "We will take
        // production down." makes the service the object of a verb whose
        // particle is `down`, and plans an action instead of reporting one. The
        // two readings are only ever confusable where the copula is absent,
        // which is the form the pattern admits so a headline report
        // ("PRODUCTION DOWN: every request fails.") still lands.
        //
        // Two enumerations, each with its own membership test, so a future
        // token joins the right set on purpose.
        //
        // The verb belongs when it takes the service as its object and `down`
        // as its particle, naming a deliberate change of state someone
        // performs. A verb that reports what the service itself did
        // ("production went down") does not belong: there the service is the
        // subject and the clause is a report.
        const serviceTakedownVerbs = '(?:take|bring|shut|scale|spin|wind|power|throttle|tear)';
        // The frame belongs when it leaves that verb bare, and something in the
        // frame has to be what asserts no occurrence. A finite form asserts
        // one, which is why no finite spelling is accepted: "The deploy took
        // production down." reports an outage and stays CRITICAL.
        //
        // A modal carries that on its own: `will take` plans the takedown, and
        // no modal in the list can head a report of one.
        const modalTakedownFrame = "(?:will|[’']ll|shall|would|must|should|may|might|can|could)";
        // An infinitival `to` carries nothing on its own - it is two characters
        // shared by every reading of the complement, including the ones that
        // report actual downtime ("we ended up having to take production down
        // for three hours", "we had no choice but to take production down").
        // What asserts no occurrence there is the matrix above the `to`, so the
        // `to` arm is admitted only under a named matrix and an unnamed one
        // keeps the floor. That direction is deliberate: the floor is
        // irreversible, so an unrecognised matrix must cost a false CRITICAL
        // rather than a lost outage report, and no enumeration of the matrices
        // that do report can substitute for it - both spellings above are
        // periphrastic and no single matrix verb governs their `to` at all.
        //
        // A matrix belongs when its complement can be cancelled: "we needed to
        // take production down but could not get approval" is coherent, so
        // `needed to` belongs; the same continuation after "we had to"
        // contradicts itself, so `had to` does not. `plan to`, `decided to`,
        // `tried to` and the reported-speech `says to` all survive the
        // cancellation. Every listed lemma is non-implicative in every tense,
        // except the two where tense alone decides: `have to` and `is forced
        // to` are prospective obligations, while their past and progressive
        // forms report what was done, so only the present forms are listed.
        const plannedTakedownMatrix =
            '(?:need(?:s|ed|ing)?|plan(?:s|ned|ning)?|decid(?:e|es|ed|ing)|tr(?:y|ies|ied|ying)|say(?:s|ing)?|said|ha(?:ve|s)|(?:am|is|are)\\s+forced)';
        const volitionalTakedownFrame = `(?:${modalTakedownFrame}|${plannedTakedownMatrix}\\s+to)`;
        const takedownObjectDeterminers = '(?:the|our|its|their|your|a|an|all|both)';
        const plannedTakedownPrefix = new RegExp(
            `\\b${volitionalTakedownFrame}\\s+(?:\\w+ly\\s+)?${serviceTakedownVerbs}\\s+(?:${takedownObjectDeterminers}\\s+)*$`,
            'i',
        );
        // Second, the term in modifier position inside a compound noun whose
        // head names the tooling or practice aimed at that incident class:
        // "security vulnerability scanning" is something a team adds to CI, not
        // something that happened to it. `nonIncidentSuffix` already encodes
        // this for one such head ("prevention"); these are the rest of the set.
        //
        // A head belongs when naming it asserts a capability that exists
        // whether or not any instance ever occurs. A head does not belong when
        // it presupposes an instance: "postmortem", "root cause", "report",
        // "incident" and "mitigation" all refer back to an incident that
        // happened and must leave it standing, so adjacency alone never
        // cancels a mention. The three of those with no absence-report reading
        // are enumerated as `incidentPresupposingHeads` above, which is what
        // holds them standing under a cancelling determiner.
        const incidentToolingHeads =
            '(?:scan(?:s|ner|ners|ning)?|tool(?:s|ing)?|check(?:s|ing)?|test(?:s|ing)?|monitoring|detection|protection|training|drills?|polic(?:y|ies)|guidelines?|checklists?|documentation)';
        const incidentToolingSuffix = new RegExp(`^\\s+${incidentToolingHeads}\\b`, 'i');

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
        // The alternatives below are five different linguistic classes, and
        // only one of them licenses the shared-subject reading the guard in the
        // loop applies. Stated per alternative so a new token joins the right
        // set on purpose:
        //   (?<=[.!?\n;])  sentence break     - no shared subject across it
        //   but, however   adversative        - contrast, never a noun list
        //   because        subordinator       - contrast, never a noun list
        //   yet            adversative coord. - contrasts, does not enumerate
        //   :              expository punct.  - labels or elaborates a topic
        //   , and or       list-forming       - the only shared-subject class
        // Splitting is the same for all of them; only the list-forming class is
        // eligible for the guard below, so `:`/`yet`/`but`/`however`/`because`
        // keep their affirmative-contrast CRITICAL deliberately.
        const clauseBoundary = new RegExp(
            `(?<=[.!?\\n;])|\\b(?:but|however|because)\\b|(?:[:,]|\\b(?:and|or|yet)\\b)(?=\\s*${independentClauseStart})`,
            'gi',
        );
        const clauses: Array<{ text: string; inheritedQuestionScope: boolean }> = [];
        let clauseStart = 0;
        let nextClauseInheritsQuestionScope: boolean = false;
        for (const boundary of content.matchAll(clauseBoundary)) {
            const preceding = content.slice(clauseStart, boundary.index);
            // Comma/and/or incident subjects without a preceding predicate share one:
            // "Data loss, production outages have not occurred" is one negative report.
            // Do not turn the first subject into a standalone affirmative report.
            // This is a coordination guard, not a general subordination guard:
            // only the list-forming class above belongs in it. A leading
            // subordinate clause is handled by conditionalProtasisPrefix, which
            // acts on the mention's position rather than on the separator.
            if (
                /^(?:,|and|or)$/i.test(boundary[0]) &&
                criticalPriorityPatterns.some((pattern) => pattern.test(preceding)) &&
                !declarativePredicate.test(preceding) &&
                !questionStart.test(preceding)
            )
                continue;
            clauses.push({
                text: preceding,
                inheritedQuestionScope: nextClauseInheritsQuestionScope,
            });
            const carriesInheritedQuestionScope: boolean =
                nextClauseInheritsQuestionScope && /^(?:and|or)$/i.test(boundary[0]);
            nextClauseInheritsQuestionScope =
                carriesInheritedQuestionScope ||
                (/^because$/i.test(boundary[0]) && causalDiagnosticQuestionStart.test(preceding));
            clauseStart = boundary.index + boundary[0].length;
        }
        clauses.push({
            text: content.slice(clauseStart),
            inheritedQuestionScope: nextClauseInheritsQuestionScope,
        });
        let earlierQuestion = false;
        const hasCriticalIncident = clauses.some(({ text: clause, inheritedQuestionScope }) => {
            const startsQuestion = questionStart.test(clause);
            // In "Can you help because production is down?", the final question
            // mark belongs to the help request; the declarative clause reports
            // the incident. A bare "Production is down?" remains a question.
            const hasDeclarativePredicate = declarativePredicate.test(clause);
            const isQuestion =
                inheritedQuestionScope ||
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
                    const prefixWithoutNotOnly = prefix.replace(affirmativeNotOnly, ' ');
                    const suffixWithoutNotOnly = suffix.replace(affirmativeNotOnly, ' ');
                    const hasNonIncidentPrefixMatch = hasNonIncidentPrefix(
                        prefixWithoutNotOnly,
                        suffixWithoutNotOnly,
                    );
                    const hasNonIncidentSuffix =
                        !failedPassivePreventionSuffix.test(suffixWithoutNotOnly) &&
                        nonIncidentSuffix.test(suffixWithoutNotOnly);
                    const inConditionalProtasis =
                        conditionalProtasisPrefix.test(prefixWithoutNotOnly);
                    // Scoped to the one pattern whose match can end in the
                    // particle; no other incident term has a takedown reading.
                    const namesPlannedTakedown =
                        /\bdown$/i.test(match[0]) &&
                        plannedTakedownPrefix.test(prefixWithoutNotOnly);
                    const namesIncidentTooling = incidentToolingSuffix.test(suffixWithoutNotOnly);
                    if (
                        !inConditionalProtasis &&
                        !namesPlannedTakedown &&
                        !namesIncidentTooling &&
                        !hasNonIncidentPrefixMatch &&
                        !hasNonIncidentSuffix
                    ) {
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

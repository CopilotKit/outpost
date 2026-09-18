/**
 * Sentiment analyzer for account health scoring.
 *
 * Analyzes message content using Luna to determine the percentage
 * of negative sentiment, frustration level, and satisfaction signals.
 * Designed for batch analysis of all messages from an account in a single call.
 */

import { z } from 'zod';
import { AuxiliaryModel, auxiliaryErrorUsage } from './auxiliary-model.js';
import type { AuxiliaryModelOptions } from './auxiliary-model.js';
import type { SentimentResult } from './types.js';
import { SentimentLabel } from './types.js';
import { config } from './config.js';

const SENTIMENT_SYSTEM_PROMPT = `You are a sentiment analyzer for a developer support platform. Analyze the provided messages and respond with ONLY a JSON object (no markdown, no explanation):

{
  "score": <number 0-100>,
  "label": "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "CRITICAL"
}

Scoring guidelines:
- **score** is the percentage of negative sentiment across all messages (0 = entirely positive, 100 = entirely negative/hostile)
- Look for: frustration, anger, confusion, satisfaction, gratitude, urgency, threats to leave
- Consider: tone, word choice, exclamation marks, caps, profanity, passive-aggression
- A mix of positive and negative messages should reflect the overall balance

Label thresholds:
- POSITIVE: score 0-20 (mostly happy, grateful, satisfied)
- NEUTRAL: score 21-45 (matter-of-fact, no strong sentiment either way)
- NEGATIVE: score 46-70 (frustrated, unhappy, complaining)
- CRITICAL: score 71-100 (angry, threatening to churn, hostile, escalation-worthy)`;

/**
 * Analyze sentiment across a batch of messages.
 *
 * Sends all messages to Luna in a single call for cost-effective
 * batch analysis. Returns a score (0-100, % negative) and a label.
 */
export async function analyzeSentiment(
    messages: string[],
    options?: AuxiliaryModelOptions,
): Promise<SentimentResult & { degraded: boolean }> {
    if (messages.length === 0) {
        return {
            score: 25,
            label: SentimentLabel.NEUTRAL,
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            degraded: false,
        };
    }

    // Format messages as a numbered list for the prompt
    const formatted = messages.map((msg, i) => `[Message ${i + 1}]: ${msg}`).join('\n\n');

    // Truncate to ~8000 chars to stay within reasonable token limits
    const truncated = formatted.slice(0, 8000);

    try {
        const model = new AuxiliaryModel(config.sentimentModel, options);
        const { output: parsed, tokenUsage } = await model.run({
            name: 'Outpost sentiment analysis',
            instructions: SENTIMENT_SYSTEM_PROMPT,
            input: truncated,
            schema: z.object({ score: z.number().min(0).max(100), label: z.enum(SentimentLabel) }),
            maxTokens: config.maxSentimentTokens,
            temperature: config.sentimentTemperature,
        });

        return {
            ...parsed,
            score: Math.round(parsed.score),
            tokenUsage,
            degraded: false,
        };
    } catch (error) {
        console.error(
            `[Sentiment] Analysis failed, returning neutral fallback:`,
            error instanceof Error ? error.message : 'Unknown error',
        );
        // Fallback: return neutral on failure
        return {
            score: 50,
            label: SentimentLabel.NEUTRAL,
            tokenUsage: auxiliaryErrorUsage(error),
            degraded: true,
        };
    }
}

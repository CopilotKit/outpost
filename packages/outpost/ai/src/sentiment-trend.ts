/**
 * Sentiment trend analysis for detecting accounts that are becoming unhappy.
 *
 * Analyzes sentiment across time periods to identify early churn signals.
 * Groups messages by period, runs sentiment analysis on each, and computes
 * the overall trend direction.
 */

import { analyzeSentiment } from './sentiment.js';
import type { SentimentPeriod, SentimentTrendResult } from './types.js';
import { SentimentLabel } from './types.js';

export interface TimestampedMessage {
    content: string;
    createdAt: Date;
}

export interface TrendOptions {
    apiKey?: string;
    model?: string;
}

/**
 * Minimum score delta to consider a trend as IMPROVING or DECLINING.
 * Anything within this range is considered STABLE.
 */
const TREND_THRESHOLD = 10;

/**
 * Analyze sentiment over time for an account.
 *
 * Groups messages into the provided time periods, runs sentiment analysis
 * on each period, and determines whether the account's sentiment is
 * improving, stable, or declining.
 *
 * @param messages - All messages for the account, with timestamps
 * @param periods - Array of { start, end } date pairs to group messages into
 * @param options - Optional API key and model overrides
 */
export async function getSentimentTrend(
    messages: TimestampedMessage[],
    periods: Array<{ start: Date; end: Date }>,
    options?: TrendOptions,
): Promise<SentimentTrendResult> {
    if (periods.length === 0) {
        return {
            periods: [],
            trend: 'STABLE',
            delta: 0,
        };
    }

    // Group messages by period
    const grouped = periods.map((period) => {
        const periodMessages = messages.filter(
            (m) => m.createdAt >= period.start && m.createdAt < period.end,
        );
        return {
            start: period.start,
            end: period.end,
            messages: periodMessages.map((m) => m.content),
        };
    });

    // Analyze sentiment for each period
    const results: SentimentPeriod[] = [];

    for (const group of grouped) {
        if (group.messages.length === 0) {
            results.push({
                periodStart: group.start.toISOString(),
                periodEnd: group.end.toISOString(),
                score: 25,
                label: SentimentLabel.NEUTRAL,
                messageCount: 0,
            });
            continue;
        }

        const sentiment = await analyzeSentiment(group.messages, options);
        results.push({
            periodStart: group.start.toISOString(),
            periodEnd: group.end.toISOString(),
            score: sentiment.score,
            label: sentiment.label,
            messageCount: group.messages.length,
        });
    }

    // Calculate trend from first to last non-empty period
    const nonEmpty = results.filter((r) => r.messageCount > 0);
    let delta = 0;
    let trend: SentimentTrendResult['trend'] = 'STABLE';

    if (nonEmpty.length >= 2) {
        const first = nonEmpty[0];
        const last = nonEmpty[nonEmpty.length - 1];
        delta = last.score - first.score;

        // Positive delta means sentiment is getting MORE negative (score = % negative)
        if (delta > TREND_THRESHOLD) {
            trend = 'DECLINING';
        } else if (delta < -TREND_THRESHOLD) {
            trend = 'IMPROVING';
        }
    }

    return {
        periods: results,
        trend,
        delta,
    };
}

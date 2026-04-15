/**
 * Types for the customer messaging system.
 * Covers Slack Connect and MS Teams channels.
 */

export enum MessageSource {
    SLACK = 'SLACK',
    TEAMS = 'TEAMS',
}

export enum UrgencyLevel {
    LOW = 'LOW',         // < 1 hour unanswered
    MEDIUM = 'MEDIUM',   // 1-4 hours unanswered
    HIGH = 'HIGH',       // > 4 hours unanswered
}

export enum MessageStatus {
    UNANSWERED = 'UNANSWERED',
    ANSWERED = 'ANSWERED',
}

export interface PendingMessage {
    id: string;
    customerName: string;
    accountId: string;
    accountName: string;
    accountAcv: number;
    source: MessageSource;
    channelName: string;
    messagePreview: string;
    receivedAt: string;   // ISO 8601
    status: MessageStatus;
    answeredAt?: string;  // ISO 8601, only if answered
}

export interface MessagingStats {
    totalPending: number;
    overdueCount: number;
    slackCount: number;
    teamsCount: number;
    avgResponseTimeMs: number;
}

export type MessageSortKey = 'recent' | 'oldest_unanswered' | 'acv';

export interface MessageFilters {
    source?: MessageSource;
    status?: MessageStatus;
    accountId?: string;
}

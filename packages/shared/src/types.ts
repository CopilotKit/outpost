/**
 * Core types shared across all Outpost apps and packages.
 */

export enum TicketStatus {
    OPEN = 'OPEN',
    IN_PROGRESS = 'IN_PROGRESS',
    WAITING_ON_CUSTOMER = 'WAITING_ON_CUSTOMER',
    WAITING_ON_TEAM = 'WAITING_ON_TEAM',
    RESOLVED = 'RESOLVED',
    CLOSED = 'CLOSED',
}

export enum TicketPriority {
    CRITICAL = 'CRITICAL',
    HIGH = 'HIGH',
    MEDIUM = 'MEDIUM',
    LOW = 'LOW',
}

export enum TicketType {
    BUG = 'BUG',
    FEATURE_REQUEST = 'FEATURE_REQUEST',
    QUESTION = 'QUESTION',
    INTEGRATION_HELP = 'INTEGRATION_HELP',
    ACCOUNT_ISSUE = 'ACCOUNT_ISSUE',
    OTHER = 'OTHER',
}

export enum TicketSource {
    DISCORD = 'DISCORD',
    SLACK = 'SLACK',
    GITHUB_ISSUE = 'GITHUB_ISSUE',
    GITHUB_DISCUSSION = 'GITHUB_DISCUSSION',
    WEB = 'WEB',
    EMAIL = 'EMAIL',
    MANUAL = 'MANUAL',
}

export enum MessageType {
    USER = 'USER',
    BOT = 'BOT',
    SYSTEM = 'SYSTEM',
}

export enum JobStatus {
    PENDING = 'PENDING',
    PROCESSING = 'PROCESSING',
    COMPLETED = 'COMPLETED',
    FAILED = 'FAILED',
}

export enum AgentStatus {
    ACTIVE = 'ACTIVE',
    PAUSED = 'PAUSED',
    ERROR = 'ERROR',
}

export enum BroadcastStatus {
    DRAFT = 'DRAFT',
    SENT = 'SENT',
}

export enum BroadcastAudience {
    ALL_ACCOUNTS = 'ALL_ACCOUNTS',
    SELECTED_ACCOUNTS = 'SELECTED_ACCOUNTS',
    BY_SENTIMENT = 'BY_SENTIMENT',
}

export enum DocStatus {
    DRAFT = 'DRAFT',
    PUBLISHED = 'PUBLISHED',
}

export enum SlaMetric {
    FIRST_RESPONSE = 'FIRST_RESPONSE',
    RESOLUTION = 'RESOLUTION',
}

export enum AccountSentiment {
    HAPPY = 'HAPPY',
    NEUTRAL = 'NEUTRAL',
    AT_RISK = 'AT_RISK',
    CHURNING = 'CHURNING',
}

export enum AccountEngagement {
    HIGH = 'HIGH',
    MEDIUM = 'MEDIUM',
    LOW = 'LOW',
    INACTIVE = 'INACTIVE',
}

export enum TeamMemberRole {
    ADMIN = 'ADMIN',
    SUPPORT = 'SUPPORT',
    ENGINEER = 'ENGINEER',
    VIEWER = 'VIEWER',
}

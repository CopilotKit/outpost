'use client';

import { MessageInbox } from '@/components/messaging/message-inbox';
import { MOCK_PENDING_MESSAGES } from '@/lib/mock-messages';

export default function MessagingPage() {
    return <MessageInbox messages={MOCK_PENDING_MESSAGES} />;
}

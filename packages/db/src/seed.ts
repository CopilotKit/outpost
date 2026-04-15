import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Seeding database...');

    // ─── Team Members ───────────────────────────────────────────────────
    const teamMembers = await Promise.all([
        prisma.teamMember.create({
            data: {
                name: 'Alex Chen',
                email: 'alex@copilotkit.ai',
                role: 'ADMIN',
                avatarUrl: 'https://api.dicebear.com/7.x/avataaars/svg?seed=alex',
            },
        }),
        prisma.teamMember.create({
            data: {
                name: 'Sam Rivera',
                email: 'sam@copilotkit.ai',
                role: 'SUPPORT',
                avatarUrl: 'https://api.dicebear.com/7.x/avataaars/svg?seed=sam',
            },
        }),
        prisma.teamMember.create({
            data: {
                name: 'Jordan Lee',
                email: 'jordan@copilotkit.ai',
                role: 'ENGINEER',
                avatarUrl: 'https://api.dicebear.com/7.x/avataaars/svg?seed=jordan',
            },
        }),
    ]);

    // ─── Accounts ───────────────────────────────────────────────────────
    const accounts = await Promise.all([
        prisma.account.create({
            data: {
                name: 'Acme Corp',
                domain: 'acme.com',
                owner: teamMembers[0].id,
                sentiment: 'HAPPY',
                engagement: 'HIGH',
                acv: 120000,
                closeDate: new Date('2025-01-15'),
            },
        }),
        prisma.account.create({
            data: {
                name: 'TechStart Inc',
                domain: 'techstart.io',
                owner: teamMembers[1].id,
                sentiment: 'NEUTRAL',
                engagement: 'MEDIUM',
                acv: 45000,
                closeDate: new Date('2025-03-01'),
            },
        }),
        prisma.account.create({
            data: {
                name: 'DataFlow Systems',
                domain: 'dataflow.dev',
                owner: teamMembers[0].id,
                sentiment: 'AT_RISK',
                engagement: 'LOW',
                acv: 85000,
                closeDate: new Date('2024-11-20'),
            },
        }),
        prisma.account.create({
            data: {
                name: 'CloudNine Labs',
                domain: 'cloudnine.io',
                owner: teamMembers[2].id,
                sentiment: 'HAPPY',
                engagement: 'HIGH',
                acv: 200000,
                closeDate: new Date('2025-06-01'),
            },
        }),
        prisma.account.create({
            data: {
                name: 'NextGen AI',
                domain: 'nextgenai.com',
                owner: teamMembers[1].id,
                sentiment: 'NEUTRAL',
                engagement: 'MEDIUM',
                acv: 60000,
            },
        }),
    ]);

    // ─── Users ──────────────────────────────────────────────────────────
    const users = await Promise.all([
        prisma.user.create({
            data: {
                name: 'Alice Johnson',
                email: 'alice@acme.com',
                domain: 'acme.com',
                externalId: 'alice_j',
                source: 'DISCORD',
                accountId: accounts[0].id,
            },
        }),
        prisma.user.create({
            data: {
                name: 'Bob Smith',
                email: 'bob@techstart.io',
                domain: 'techstart.io',
                externalId: 'bobsmith',
                source: 'GITHUB_ISSUE',
                accountId: accounts[1].id,
            },
        }),
        prisma.user.create({
            data: {
                name: 'Carol Danvers',
                email: 'carol@dataflow.dev',
                domain: 'dataflow.dev',
                externalId: 'cdanvers',
                source: 'DISCORD',
                accountId: accounts[2].id,
            },
        }),
        prisma.user.create({
            data: {
                name: 'Dave Wilson',
                email: 'dave@cloudnine.io',
                domain: 'cloudnine.io',
                externalId: 'davew',
                source: 'GITHUB_DISCUSSION',
                accountId: accounts[3].id,
            },
        }),
        prisma.user.create({
            data: {
                name: 'Eve Martinez',
                email: 'eve@nextgenai.com',
                domain: 'nextgenai.com',
                externalId: 'evem',
                source: 'WEB',
                accountId: accounts[4].id,
            },
        }),
    ]);

    // ─── Tickets ────────────────────────────────────────────────────────
    const ticketData = [
        {
            displayId: 'TKT-A1B2',
            title: 'CopilotKit agent not responding after deploy',
            description: 'After deploying to production, our CopilotKit agent stops responding to user messages. Works fine locally.',
            status: 'OPEN' as const,
            priority: 'CRITICAL' as const,
            type: 'BUG' as const,
            source: 'DISCORD' as const,
            channel: '#support',
            accountId: accounts[0].id,
            userId: users[0].id,
            assigneeId: teamMembers[2].id,
        },
        {
            displayId: 'TKT-C3D4',
            title: 'How to configure multi-agent setup?',
            description: 'Looking for guidance on setting up multiple agents with CopilotKit. The docs mention it but no examples.',
            status: 'IN_PROGRESS' as const,
            priority: 'MEDIUM' as const,
            type: 'QUESTION' as const,
            source: 'GITHUB_DISCUSSION' as const,
            sourceUrl: 'https://github.com/CopilotKit/CopilotKit/discussions/123',
            accountId: accounts[1].id,
            userId: users[1].id,
            assigneeId: teamMembers[0].id,
        },
        {
            displayId: 'TKT-E5F6',
            title: 'Feature request: Streaming support for tool calls',
            description: 'It would be great to have streaming support when tools are executing, so users can see progress.',
            status: 'OPEN' as const,
            priority: 'LOW' as const,
            type: 'FEATURE_REQUEST' as const,
            source: 'GITHUB_ISSUE' as const,
            sourceUrl: 'https://github.com/CopilotKit/CopilotKit/issues/456',
            accountId: accounts[3].id,
            userId: users[3].id,
        },
        {
            displayId: 'TKT-G7H8',
            title: 'Integration failing with Next.js 15',
            description: 'Getting hydration errors when using CopilotKit with Next.js 15 app router. Stack trace attached.',
            status: 'WAITING_ON_TEAM' as const,
            priority: 'HIGH' as const,
            type: 'INTEGRATION_HELP' as const,
            source: 'DISCORD' as const,
            channel: '#integration-help',
            accountId: accounts[2].id,
            userId: users[2].id,
            assigneeId: teamMembers[2].id,
        },
        {
            displayId: 'TKT-J9K1',
            title: 'Billing inquiry - upgrade from Pro to Enterprise',
            description: 'We need to upgrade our plan. Currently on Pro but need enterprise features for SOC2 compliance.',
            status: 'WAITING_ON_CUSTOMER' as const,
            priority: 'MEDIUM' as const,
            type: 'ACCOUNT_ISSUE' as const,
            source: 'EMAIL' as const,
            accountId: accounts[4].id,
            userId: users[4].id,
            assigneeId: teamMembers[1].id,
        },
        {
            displayId: 'TKT-L2M3',
            title: 'useCopilotAction hook not triggering',
            description: 'The useCopilotAction hook is registered but never gets called. Using React 18 with Vite.',
            status: 'OPEN' as const,
            priority: 'HIGH' as const,
            type: 'BUG' as const,
            source: 'DISCORD' as const,
            channel: '#support',
            accountId: accounts[0].id,
            userId: users[0].id,
        },
        {
            displayId: 'TKT-N4P5',
            title: 'Custom UI component rendering question',
            description: 'How do we render custom React components in the CopilotKit chat? Docs are unclear on this.',
            status: 'RESOLVED' as const,
            priority: 'LOW' as const,
            type: 'QUESTION' as const,
            source: 'GITHUB_DISCUSSION' as const,
            accountId: accounts[1].id,
            userId: users[1].id,
            assigneeId: teamMembers[0].id,
        },
        {
            displayId: 'TKT-Q6R7',
            title: 'Memory leak in long-running agent sessions',
            description: 'After ~2 hours of continuous agent interaction, memory usage grows unbounded. Need investigation.',
            status: 'IN_PROGRESS' as const,
            priority: 'CRITICAL' as const,
            type: 'BUG' as const,
            source: 'WEB' as const,
            accountId: accounts[3].id,
            userId: users[3].id,
            assigneeId: teamMembers[2].id,
        },
        {
            displayId: 'TKT-S8T9',
            title: 'Request for Python SDK',
            description: 'Our backend is Python-based. Would love a Python SDK for CopilotKit server-side integration.',
            status: 'OPEN' as const,
            priority: 'MEDIUM' as const,
            type: 'FEATURE_REQUEST' as const,
            source: 'GITHUB_ISSUE' as const,
            sourceUrl: 'https://github.com/CopilotKit/CopilotKit/issues/789',
            accountId: accounts[2].id,
            userId: users[2].id,
        },
        {
            displayId: 'TKT-U1V2',
            title: 'CORS error when connecting to self-hosted runtime',
            description: 'Getting CORS errors when the frontend tries to connect to our self-hosted CopilotKit runtime.',
            status: 'OPEN' as const,
            priority: 'HIGH' as const,
            type: 'INTEGRATION_HELP' as const,
            source: 'DISCORD' as const,
            channel: '#integration-help',
            accountId: accounts[4].id,
            userId: users[4].id,
        },
        {
            displayId: 'TKT-W3X4',
            title: 'Webhook delivery failures',
            description: 'Our webhook endpoint is receiving duplicate events and some events are missing.',
            status: 'IN_PROGRESS' as const,
            priority: 'HIGH' as const,
            type: 'BUG' as const,
            source: 'WEB' as const,
            accountId: accounts[0].id,
            userId: users[0].id,
            assigneeId: teamMembers[1].id,
        },
        {
            displayId: 'TKT-Y5Z6',
            title: 'Agent context not persisting across sessions',
            description: 'When a user closes and reopens the chat, all previous context is lost. Need persistent memory.',
            status: 'OPEN' as const,
            priority: 'MEDIUM' as const,
            type: 'FEATURE_REQUEST' as const,
            source: 'DISCORD' as const,
            channel: '#feature-requests',
            accountId: accounts[1].id,
            userId: users[1].id,
        },
        {
            displayId: 'TKT-A7B8',
            title: 'TypeScript type errors after v1.5 upgrade',
            description: 'After upgrading to CopilotKit 1.5, getting type mismatches in useCopilotChat.',
            status: 'RESOLVED' as const,
            priority: 'MEDIUM' as const,
            type: 'BUG' as const,
            source: 'GITHUB_ISSUE' as const,
            sourceUrl: 'https://github.com/CopilotKit/CopilotKit/issues/234',
            accountId: accounts[3].id,
            userId: users[3].id,
            assigneeId: teamMembers[0].id,
        },
        {
            displayId: 'TKT-C9D1',
            title: 'Rate limiting configuration for production',
            description: 'Need guidance on configuring rate limits for our production deployment with ~10k daily users.',
            status: 'WAITING_ON_CUSTOMER' as const,
            priority: 'MEDIUM' as const,
            type: 'QUESTION' as const,
            source: 'EMAIL' as const,
            accountId: accounts[2].id,
            userId: users[2].id,
            assigneeId: teamMembers[1].id,
        },
        {
            displayId: 'TKT-E2F3',
            title: 'SSO integration with Okta',
            description: 'Our enterprise requires Okta SSO. Is this supported or on the roadmap?',
            status: 'OPEN' as const,
            priority: 'HIGH' as const,
            type: 'ACCOUNT_ISSUE' as const,
            source: 'EMAIL' as const,
            accountId: accounts[4].id,
            userId: users[4].id,
            assigneeId: teamMembers[0].id,
        },
        {
            displayId: 'TKT-G4H5',
            title: 'Documentation missing for ag-ui protocol',
            description: 'The ag-ui protocol docs seem incomplete. Missing sections on error handling and reconnection.',
            status: 'OPEN' as const,
            priority: 'MEDIUM' as const,
            type: 'QUESTION' as const,
            source: 'GITHUB_DISCUSSION' as const,
            sourceUrl: 'https://github.com/CopilotKit/CopilotKit/discussions/567',
            accountId: accounts[0].id,
            userId: users[0].id,
        },
        {
            displayId: 'TKT-J6K7',
            title: 'Agent tool execution timeout',
            description: 'Tool calls are timing out after 30s. Need to increase timeout or add retry logic.',
            status: 'CLOSED' as const,
            priority: 'LOW' as const,
            type: 'BUG' as const,
            source: 'DISCORD' as const,
            channel: '#support',
            accountId: accounts[1].id,
            userId: users[1].id,
            assigneeId: teamMembers[2].id,
        },
        {
            displayId: 'TKT-L8M9',
            title: 'Request for GraphQL API support',
            description: 'Would be great to have first-class GraphQL support alongside REST for the runtime API.',
            status: 'OPEN' as const,
            priority: 'LOW' as const,
            type: 'FEATURE_REQUEST' as const,
            source: 'GITHUB_ISSUE' as const,
            sourceUrl: 'https://github.com/CopilotKit/CopilotKit/issues/890',
            accountId: accounts[3].id,
            userId: users[3].id,
        },
        {
            displayId: 'TKT-N1P2',
            title: 'Multi-tenant setup best practices',
            description: 'Building a SaaS with CopilotKit. Need guidance on isolating agent contexts per tenant.',
            status: 'IN_PROGRESS' as const,
            priority: 'HIGH' as const,
            type: 'INTEGRATION_HELP' as const,
            source: 'WEB' as const,
            accountId: accounts[4].id,
            userId: users[4].id,
            assigneeId: teamMembers[0].id,
        },
        {
            displayId: 'TKT-Q3R4',
            title: 'Chat widget styling broken in dark mode',
            description: 'The CopilotKit chat widget has contrast issues in dark mode. Text is nearly invisible.',
            status: 'OPEN' as const,
            priority: 'MEDIUM' as const,
            type: 'BUG' as const,
            source: 'DISCORD' as const,
            channel: '#support',
            accountId: accounts[2].id,
            userId: users[2].id,
        },
    ];

    const tickets = [];
    for (const data of ticketData) {
        const ticket = await prisma.ticket.create({ data });
        tickets.push(ticket);
    }

    // ─── Messages ───────────────────────────────────────────────────────
    const messageData = [
        { ticketId: tickets[0].id, author: users[0].name, content: 'This started happening right after we deployed v2.1.0 to production.', type: 'USER' as const },
        { ticketId: tickets[0].id, author: 'Outpost AI', content: 'I found a similar issue reported in #431. The fix involves updating the runtime configuration to include the new API endpoint. Let me check if this applies to your case.', type: 'BOT' as const, isAiGenerated: true },
        { ticketId: tickets[0].id, author: teamMembers[2].name, content: 'Looking into this now. Can you share your runtime config?', type: 'USER' as const },
        { ticketId: tickets[1].id, author: users[1].name, content: 'I have two agents: one for code generation and one for documentation. How do I route between them?', type: 'USER' as const },
        { ticketId: tickets[1].id, author: teamMembers[0].name, content: 'Check out the multi-agent guide at docs.copilotkit.ai/guides/multi-agent. You can use the agentName parameter.', type: 'USER' as const },
        { ticketId: tickets[3].id, author: users[2].name, content: 'Here is the full stack trace from the hydration error.', type: 'USER' as const },
        { ticketId: tickets[3].id, author: 'System', content: 'Ticket escalated to engineering team.', type: 'SYSTEM' as const },
        { ticketId: tickets[7].id, author: users[3].name, content: 'Memory grows from 200MB to 2GB over 2 hours. Chrome DevTools heap snapshot attached.', type: 'USER' as const },
        { ticketId: tickets[7].id, author: teamMembers[2].name, content: 'This looks like it could be related to event listener cleanup. Investigating.', type: 'USER' as const },
        { ticketId: tickets[10].id, author: users[0].name, content: 'We are seeing about 15% of webhook events being duplicated.', type: 'USER' as const },
    ];

    for (const data of messageData) {
        await prisma.message.create({ data });
    }

    // ─── Doc Categories & Articles ──────────────────────────────────────
    const categories = await Promise.all([
        prisma.docCategory.create({
            data: { name: 'Getting Started', description: 'Quick start guides and tutorials' },
        }),
        prisma.docCategory.create({
            data: { name: 'API Reference', description: 'Complete API documentation' },
        }),
        prisma.docCategory.create({
            data: { name: 'Guides', description: 'In-depth guides for common use cases' },
        }),
    ]);

    await Promise.all([
        prisma.docArticle.create({
            data: {
                title: 'Quick Start with CopilotKit',
                content: 'This guide walks you through setting up CopilotKit in your Next.js application...',
                status: 'PUBLISHED',
                categoryId: categories[0].id,
                sourceUrl: 'https://docs.copilotkit.ai/quickstart',
            },
        }),
        prisma.docArticle.create({
            data: {
                title: 'CopilotKit Runtime API',
                content: 'Complete reference for the CopilotKit runtime API endpoints...',
                status: 'PUBLISHED',
                categoryId: categories[1].id,
                sourceUrl: 'https://docs.copilotkit.ai/reference/runtime',
            },
        }),
        prisma.docArticle.create({
            data: {
                title: 'Multi-Agent Setup Guide',
                content: 'Learn how to configure and orchestrate multiple agents with CopilotKit...',
                status: 'DRAFT',
                categoryId: categories[2].id,
            },
        }),
    ]);

    // ─── SLA Configs ────────────────────────────────────────────────────
    const slaData = [
        // First response targets: CRITICAL 5m, HIGH 5m, MEDIUM 15m, LOW 60m
        { metric: 'FIRST_RESPONSE' as const, priority: 'CRITICAL' as const, targetMinutes: 5 },
        { metric: 'FIRST_RESPONSE' as const, priority: 'HIGH' as const, targetMinutes: 5 },
        { metric: 'FIRST_RESPONSE' as const, priority: 'MEDIUM' as const, targetMinutes: 15 },
        { metric: 'FIRST_RESPONSE' as const, priority: 'LOW' as const, targetMinutes: 60 },
        // Resolution targets: CRITICAL 4h, HIGH 4h, MEDIUM 24h, LOW 168h (1 week)
        { metric: 'RESOLUTION' as const, priority: 'CRITICAL' as const, targetMinutes: 240 },
        { metric: 'RESOLUTION' as const, priority: 'HIGH' as const, targetMinutes: 240 },
        { metric: 'RESOLUTION' as const, priority: 'MEDIUM' as const, targetMinutes: 1440 },
        { metric: 'RESOLUTION' as const, priority: 'LOW' as const, targetMinutes: 10080 },
    ];

    for (const data of slaData) {
        await prisma.slaConfig.create({ data });
    }

    // ─── Agents ─────────────────────────────────────────────────────────
    await Promise.all([
        prisma.agent.create({
            data: {
                name: 'Auto-Responder',
                description: 'Automatically responds to common questions using the knowledge base',
                config: { confidenceThreshold: 0.85, maxResponseLength: 500 },
                status: 'ACTIVE',
                lastRun: new Date(),
            },
        }),
        prisma.agent.create({
            data: {
                name: 'SLA Monitor',
                description: 'Monitors tickets approaching SLA breach and alerts the team',
                config: { checkIntervalMinutes: 5, alertThresholdPercent: 80 },
                status: 'ACTIVE',
                lastRun: new Date(),
            },
        }),
        prisma.agent.create({
            data: {
                name: 'Sentiment Analyzer',
                description: 'Analyzes customer messages to update account sentiment scores',
                config: { batchSize: 50, runIntervalMinutes: 30 },
                status: 'PAUSED',
            },
        }),
    ]);

    console.log('Seed complete!');
    console.log(`  - ${teamMembers.length} team members`);
    console.log(`  - ${accounts.length} accounts`);
    console.log(`  - ${users.length} users`);
    console.log(`  - ${tickets.length} tickets`);
    console.log(`  - ${messageData.length} messages`);
    console.log(`  - ${categories.length} doc categories`);
    console.log(`  - 3 doc articles`);
    console.log(`  - ${slaData.length} SLA configs`);
    console.log(`  - 3 agents`);
}

main()
    .then(async () => {
        await prisma.$disconnect();
    })
    .catch(async (e) => {
        console.error(e);
        await prisma.$disconnect();
        process.exit(1);
    });

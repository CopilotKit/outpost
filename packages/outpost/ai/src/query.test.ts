import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { LLMock } from '@copilotkit/aimock';
import { SearchQueryBuilder, heuristicSearchQuery } from './query.js';

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

// ─── Fixtures ───────────────────────────────────────────────────────────────

/**
 * A forum post long enough to trip distillation, carrying Discord markup, a
 * pasted channel sidebar, and issue-template boilerplate around one question.
 */
const NOISY_POST = [
    '<:copilotkit:1187213988392189962> hey <@!284920412034990081> :wave:',
    '',
    'I posted this in <#1205139168783503400> already but reposting here since',
    '<#1379082175625953370> said this was the right place to ask about it.',
    '',
    'Channels',
    '# ┃welcome',
    '# ┃announcements',
    '# ┃support',
    '',
    '## Pre-flight Checklist',
    '- [x] I have searched existing issues',
    '- [ ] I am willing to submit a PR',
    '',
    '### ♻️ Reproduction Steps',
    '1. npx create-next-app',
    '2. install @copilotkit/react-core and wire up the provider',
    '',
    'My actual question: how do I render a custom React component from a tool call',
    'with useCopilotAction? Generative UI never renders, the tool returns text.',
    '',
    'Docs I already read: https://docs.copilotkit.ai/generative-ui <t:1738000000:R>',
].join('\n');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('heuristicSearchQuery', () => {
    it('returns an empty string when there is no prose left', () => {
        expect(heuristicSearchQuery('')).toBe('');
        expect(heuristicSearchQuery('```\nconst x = 1;\n```')).toBe('');
    });

    it('prefers the sentences that carry the question mark', () => {
        const query = heuristicSearchQuery(
            'Thanks for the release! I upgraded this morning.\nHow do I register a tool?',
        );
        expect(query).toBe('How do I register a tool?');
    });

    it('drops code fences, stack frames, and bare URLs', () => {
        const query = heuristicSearchQuery(
            [
                'Why does the runtime throw?',
                '```ts',
                'const runtime = new CopilotRuntime();',
                '```',
                '    at handler (/app/src/index.ts:12:5)',
                'https://docs.copilotkit.ai/runtime',
            ].join('\n'),
        );
        expect(query).toBe('Why does the runtime throw?');
    });

    it('falls back to the opening prose when nothing is phrased as a question', () => {
        const query = heuristicSearchQuery('The provider crashes on mount with a null ref.');
        expect(query).toBe('The provider crashes on mount with a null ref.');
    });

    it('caps the query length on a word boundary', () => {
        const query = heuristicSearchQuery('word '.repeat(200));
        expect(query.length).toBeLessThanOrEqual(300);
        expect(query.endsWith('word')).toBe(true);
    });
});

describe('SearchQueryBuilder', () => {
    let builder: SearchQueryBuilder;

    beforeEach(() => {
        builder = new SearchQueryBuilder({ apiKey: 'test-key' });
    });

    it('returns an empty query for an empty body without calling the model', async () => {
        const result = await builder.build('   ');

        expect(result.query).toBe('');
        expect(result.degraded).toBe(false);
        expect(mock.getRequests()).toHaveLength(0);
    });

    it('passes a short, already-focused message straight through', async () => {
        const result = await builder.build('How do I register a tool with useCopilotAction?');

        expect(result.query).toBe('How do I register a tool with useCopilotAction?');
        expect(result.degraded).toBe(false);
        expect(mock.getRequests()).toHaveLength(0);
    });

    it('sanitizes platform markup even on the short-circuit path', async () => {
        const result = await builder.build('<@!123> does <#456> support SSR? <:ck:789>');

        expect(result.query).toBe('does support SSR?');
        expect(result.sanitized).toBe('does support SSR?');
    });

    it('distills a long noisy body into a focused query', async () => {
        mock.onMessage(/./, {
            content: 'render a custom React component from a useCopilotAction tool call',
            usage: { input_tokens: 210, output_tokens: 18 },
        });

        const result = await builder.build(NOISY_POST);

        expect(result.query).toBe(
            'render a custom React component from a useCopilotAction tool call',
        );
        expect(result.degraded).toBe(false);
        expect(result.tokenUsage).toEqual({ inputTokens: 210, outputTokens: 18 });
    });

    it('sends the sanitized body — not the raw one — to the distiller', async () => {
        mock.onMessage(/./, {
            content: 'generative ui with useCopilotAction',
            usage: { input_tokens: 210, output_tokens: 12 },
        });

        await builder.build(NOISY_POST);

        const sent = JSON.stringify(mock.getLastRequest());
        expect(sent).not.toContain('1205139168783503400');
        expect(sent).not.toContain('Pre-flight Checklist');
        expect(sent).not.toContain('I have searched existing issues');
    });

    it('never returns the raw body as the query', async () => {
        mock.onMessage(/./, {
            content: 'generative ui with useCopilotAction',
            usage: { input_tokens: 210, output_tokens: 12 },
        });

        const result = await builder.build(NOISY_POST);

        expect(result.query.length).toBeLessThan(NOISY_POST.length / 4);
        expect(result.query).not.toContain('<#');
        expect(result.query).not.toContain('┃');
    });

    it('falls back to the heuristic when the distiller fails', async () => {
        mock.onMessage(/./, { error: { message: 'upstream unavailable' }, status: 503 });

        const result = await builder.build(NOISY_POST);

        expect(result.degraded).toBe(true);
        expect(result.query).toContain('how do I render a custom React component');
        expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it('falls back to the heuristic when the distiller returns nothing', async () => {
        mock.onMessage(/./, { content: '   ', usage: { input_tokens: 10, output_tokens: 0 } });

        const result = await builder.build(NOISY_POST);

        expect(result.degraded).toBe(true);
        expect(result.query).not.toBe('');
    });

    it('truncates an over-long distilled query', async () => {
        mock.onMessage(/./, {
            content: 'query '.repeat(200),
            usage: { input_tokens: 210, output_tokens: 400 },
        });

        const result = await builder.build(NOISY_POST);

        expect(result.query.length).toBeLessThanOrEqual(300);
    });
});

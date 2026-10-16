import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, ModelBehaviorError, ModelRefusalError, Runner } from '@openai/agents';
import { z } from 'zod';
import { StructuredOpenAIProvider } from './structured-openai-provider.js';

describe('structured Responses message phases', () => {
    afterEach(() => vi.unstubAllGlobals());
    let messageId = 0;
    const message = (text: string | string[], phase?: 'commentary' | 'final_answer') => ({
        id: `msg_${messageId++}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        ...(phase ? { phase } : {}),
        content: (Array.isArray(text) ? text : [text]).map((part) => ({
            type: 'output_text',
            text: part,
            annotations: [],
        })),
    });
    function run(output: unknown[], structured = true) {
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>().mockResolvedValue(
                new Response(
                    JSON.stringify({
                        id: 'resp_phases',
                        object: 'response',
                        created_at: 1,
                        model: 'gpt-5.6-luna',
                        status: 'completed',
                        output: [{ id: 'rsn_test', type: 'reasoning', summary: [] }, ...output],
                        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
                    }),
                    { headers: { 'content-type': 'application/json' } },
                ),
            ),
        );
        const runner = new Runner({
            modelProvider: new StructuredOpenAIProvider({ apiKey: 'test-key', useResponses: true }),
            tracingDisabled: true,
            traceIncludeSensitiveData: false,
        });
        return runner.run(
            new Agent({
                name: 'Phase test',
                model: 'gpt-5.6-luna',
                outputType: structured ? z.object({ answer: z.string() }) : 'text',
            }),
            'Answer the question.',
            { maxTurns: 1 },
        );
    }
    it('validates the final JSON without concatenating an earlier commentary draft', async () => {
        const result = await run([
            message('{"answer":"Preliminary draft"}', 'commentary'),
            message('{"answer":"Verified final"}', 'final_answer'),
        ]);
        expect(result.finalOutput).toEqual({ answer: 'Verified final' });
        expect(result.runContext.usage.inputTokens).toBe(100);
    });
    it('keeps a normal unlabelled structured response', async () => {
        expect((await run([message('{"answer":"Verified"}')])).finalOutput).toEqual({
            answer: 'Verified',
        });
    });
    it('accepts an identical final answer repeated by the provider', async () => {
        const result = await run([
            message('{"answer":"Verified"}', 'final_answer'),
            message('{"answer":"Verified"}', 'final_answer'),
        ]);
        expect(result.finalOutput).toEqual({ answer: 'Verified' });
    });
    it.each([false, true])('accepts a split final answer (repeated: %s)', async (repeated) => {
        const final = message(['{"answer":', '"Verified"}'], 'final_answer');
        const result = await run(repeated ? [final, final] : [final]);
        expect(result.finalOutput).toEqual({ answer: 'Verified' });
    });
    it.each([
        {
            name: 'unsplit then split',
            first: ['{"answer":"Verified"}'],
            second: ['{"answer":', '"Verified"}'],
        },
        {
            name: 'different split boundaries',
            first: ['{"answer":"', 'Verified"}'],
            second: ['{"answer":', '"Verified"}'],
        },
        {
            name: 'empty parts',
            first: ['', '{"answer":"Verified"}', ''],
            second: ['{"answer":', '', '"Verified"}'],
        },
    ])('accepts identical rendered final answers with $name', async ({ first, second }) => {
        const result = await run([message(first, 'final_answer'), message(second, 'final_answer')]);
        expect(result.finalOutput).toEqual({ answer: 'Verified' });
        expect(result.runContext.usage.inputTokens).toBe(100);
        expect(result.runContext.usage.outputTokens).toBe(20);
        expect(result.rawResponses[0].responseId).toBe('resp_phases');
        expect(result.rawResponses[0].output).toEqual([
            expect.objectContaining({ type: 'reasoning', id: 'rsn_test' }),
            expect.objectContaining({ type: 'message', phase: 'final_answer' }),
        ]);
    });
    it('does not choose between conflicting final answers', async () => {
        await expect(
            run([
                message('{"answer":"One"}', 'final_answer'),
                message('{"answer":"Two"}', 'final_answer'),
            ]),
        ).rejects.toBeInstanceOf(ModelBehaviorError);
    });
    it.each([
        { name: 'conflicting values', parts: ['{"answer":', '"Two"}'] },
        { name: 'different JSON whitespace', parts: ['{ "answer": ', '"One" }'] },
    ])('preserves distinct rendered final answers with $name', async ({ parts }) => {
        await expect(
            run([message('{"answer":"One"}', 'final_answer'), message(parts, 'final_answer')]),
        ).rejects.toBeInstanceOf(ModelBehaviorError);
    });
    it('keeps commentary and repeated final messages for text output', async () => {
        const result = await run(
            [
                message('Draft.', 'commentary'),
                message(['Verified', '.'], 'final_answer'),
                message('Verified.', 'final_answer'),
            ],
            false,
        );
        expect(result.finalOutput).toBe('Draft.Verified.Verified.');
        expect(result.rawResponses[0].output).toHaveLength(4);
    });
    it('does not guess between multiple unlabelled JSON messages', async () => {
        await expect(
            run([message('{"answer":"One"}'), message('{"answer":"Two"}')]),
        ).rejects.toBeInstanceOf(ModelBehaviorError);
    });
    it('still rejects malformed final output instead of accepting valid commentary', async () => {
        await expect(
            run([
                message('{"answer":"Preliminary"}', 'commentary'),
                message('{"wrong":"schema"}', 'final_answer'),
            ]),
        ).rejects.toBeInstanceOf(ModelBehaviorError);
    });
    it('preserves final refusals', async () => {
        await expect(
            run([
                message('{"answer":"Preliminary"}', 'commentary'),
                {
                    ...message('', 'final_answer'),
                    content: [{ type: 'refusal', refusal: 'Declined' }],
                },
            ]),
        ).rejects.toBeInstanceOf(ModelRefusalError);
    });
});

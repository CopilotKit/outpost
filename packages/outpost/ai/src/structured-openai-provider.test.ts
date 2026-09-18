import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, ModelBehaviorError, ModelRefusalError, Runner } from '@openai/agents';
import { z } from 'zod';
import { StructuredOpenAIProvider } from './structured-openai-provider.js';

describe('structured Responses message phases', () => {
    afterEach(() => vi.unstubAllGlobals());
    let messageId = 0;
    const message = (text: string, phase?: 'commentary' | 'final_answer') => ({
        id: `msg_${messageId++}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        ...(phase ? { phase } : {}),
        content: [{ type: 'output_text', text, annotations: [] }],
    });
    function run(output: unknown[]) {
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
                outputType: z.object({ answer: z.string() }),
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
    it('does not choose between conflicting final answers', async () => {
        await expect(
            run([
                message('{"answer":"One"}', 'final_answer'),
                message('{"answer":"Two"}', 'final_answer'),
            ]),
        ).rejects.toBeInstanceOf(ModelBehaviorError);
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

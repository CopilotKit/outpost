import Anthropic from '@anthropic-ai/sdk';
import { Agent, RunContext, Runner } from '@openai/agents';
import type { z } from 'zod';
import { StructuredOpenAIProvider } from './structured-openai-provider.js';
import { config, validateModelProvider } from './config.js';
import { extractResponseText } from './generator.js';
import { samplingParams } from './model-capabilities.js';
import type { TokenUsage } from './types.js';

export interface AuxiliaryModelOptions {
    apiKey?: string;
    model?: string;
    provider?: 'openai' | 'anthropic';
    baseURL?: string;
    tracingDisabled?: boolean;
}

/** Preserve billed usage when a completed response fails output validation. */
export class AuxiliaryModelError extends Error {
    constructor(
        cause: unknown,
        readonly tokenUsage: TokenUsage,
    ) {
        super(
            `Auxiliary model call failed (${cause instanceof Error ? cause.name : 'unknown error'})`,
            { cause },
        );
    }
}

export function auxiliaryErrorUsage(error: unknown): TokenUsage {
    return error instanceof AuxiliaryModelError
        ? error.tokenUsage
        : { inputTokens: 0, outputTokens: 0 };
}

/** A single, bounded structured judgment, with no tools or cross-provider fallback. */
export class AuxiliaryModel {
    private readonly provider: string;
    private readonly model: string;
    private readonly options: AuxiliaryModelOptions;

    constructor(defaultModel: string, options: AuxiliaryModelOptions = {}) {
        this.provider = options.provider ?? config.responseProvider;
        this.model =
            options.model ??
            (options.provider && options.provider !== config.responseProvider
                ? options.provider === 'anthropic'
                    ? 'claude-haiku-4-5-20251001'
                    : 'gpt-5.6-luna'
                : defaultModel);
        this.options = options;
        validateModelProvider(this.provider, this.model, 'auxiliary model');
    }

    async run<S extends z.ZodObject>(request: {
        name: string;
        instructions: string;
        input: string;
        schema: S;
        maxTokens: number;
        temperature: number;
    }): Promise<{ output: z.infer<S>; tokenUsage: TokenUsage }> {
        const context = new RunContext();
        let tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
        try {
            if (this.provider === 'anthropic') {
                const client = new Anthropic({
                    apiKey: this.options.apiKey ?? config.anthropicApiKey,
                    baseURL: this.options.baseURL,
                    maxRetries: 0,
                });
                const result = await client.messages.create(
                    {
                        model: this.model,
                        max_tokens: request.maxTokens,
                        ...samplingParams(this.model, request.temperature),
                        system: request.instructions,
                        messages: [{ role: 'user', content: request.input }],
                    },
                    { signal: AbortSignal.timeout(30_000) },
                );
                tokenUsage = {
                    inputTokens: result.usage.input_tokens,
                    outputTokens: result.usage.output_tokens,
                };
                if (result.stop_reason !== 'end_turn')
                    throw new Error('Auxiliary response did not complete');
                const text = extractResponseText(result.content)
                    .replace(/```(?:json)?\s*/g, '')
                    .trim();
                return { output: request.schema.parse(JSON.parse(text)), tokenUsage };
            }
            const runner = new Runner({
                modelProvider: new StructuredOpenAIProvider({
                    apiKey: this.options.apiKey ?? config.openaiApiKey,
                    baseURL: this.options.baseURL ?? process.env.OPENAI_BASE_URL,
                    useResponses: true,
                }),
                tracingDisabled:
                    this.options.tracingDisabled ??
                    process.env.OPENAI_AGENTS_DISABLE_TRACING === '1',
                traceIncludeSensitiveData: false,
                workflowName: request.name,
            });
            const result = await runner.run(
                new Agent({
                    name: request.name,
                    instructions: request.instructions,
                    model: this.model,
                    // Responses' output budget includes reasoning. 2048+ leaves room for a
                    // low-effort judgment plus the small structured answer (unlike 256/512).
                    modelSettings: {
                        reasoning: { effort: 'low' },
                        maxTokens: request.maxTokens,
                        providerData: { store: false },
                    },
                    outputType: request.schema,
                }),
                request.input,
                { context, maxTurns: 1, signal: AbortSignal.timeout(30_000) },
            );
            tokenUsage = {
                inputTokens: context.usage.inputTokens,
                outputTokens: context.usage.outputTokens,
            };
            return { output: request.schema.parse(result.finalOutput), tokenUsage };
        } catch (error) {
            if (this.provider === 'openai') {
                tokenUsage = {
                    inputTokens: context.usage.inputTokens,
                    outputTokens: context.usage.outputTokens,
                };
            }
            throw new AuxiliaryModelError(error, tokenUsage);
        }
    }
}

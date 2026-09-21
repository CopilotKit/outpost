import { OpenAIProvider } from '@openai/agents';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents';

/** SDK 0.18 concatenates commentary and final text before validating JSON.
 * Responses distinguishes them with phase; validate only the final answer.
 * Repeated final messages with identical rendered text carry no additional content.
 * Keep unlabelled/conflicting output unchanged for normal schema validation.
 */
function finalStructuredResponse(request: ModelRequest, response: ModelResponse): ModelResponse {
    if (
        request.outputType === 'text' ||
        !response.output.some(
            (item) =>
                item.type === 'message' &&
                item.role === 'assistant' &&
                item.phase === 'final_answer',
        )
    )
        return response;
    const finalTexts = new Set<string>();
    return {
        ...response,
        output: response.output.filter((item) => {
            if (item.type !== 'message' || item.role !== 'assistant') return true;
            if (item.content.some((part) => part.type !== 'output_text')) return true;
            if (item.phase === 'commentary') return false;
            if (item.phase === 'final_answer') {
                const text = item.content
                    .map((part) => (part.type === 'output_text' ? part.text : ''))
                    .join('');
                if (finalTexts.has(text)) return false;
                finalTexts.add(text);
            }
            return true;
        }),
    };
}

/** Internal provider for the buffered, structured investigator and auxiliary runs. */
export class StructuredOpenAIProvider extends OpenAIProvider {
    override async getModel(modelName?: string): Promise<Model> {
        const model = await super.getModel(modelName);
        return {
            supportsPromptModelSelection: model.supportsPromptModelSelection,
            getResponse: async (request) =>
                finalStructuredResponse(request, await model.getResponse(request)),
            getStreamedResponse: (request) => model.getStreamedResponse(request),
            ...(model.getRetryAdvice ? { getRetryAdvice: model.getRetryAdvice.bind(model) } : {}),
        };
    }
}

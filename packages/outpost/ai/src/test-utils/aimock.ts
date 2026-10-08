import { afterAll, beforeAll, beforeEach } from 'vitest';
import { LLMock } from '@copilotkit/aimock';

/** aimock 1.14's /vitest entry bundles Vitest 3 hooks, incompatible with our Vitest 4.
 * Keep the workaround here until the package exports external Vitest hooks. */
export function useAimock() {
    const llm = new LLMock({ port: 0 });
    beforeAll(async () => {
        await llm.start();
    });
    beforeEach(() => {
        llm.reset();
    });
    afterAll(async () => {
        await llm.stop();
    });
    return () => ({ llm, url: llm.url });
}

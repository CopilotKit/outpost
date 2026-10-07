import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // No `globals`: every test imports what it uses, and the app's tsconfig
        // does not include vitest's global types, so relying on them would
        // typecheck only inside the test run.
        environment: 'node',
        include: ['src/**/*.test.ts'],
        clearMocks: true,
        restoreMocks: true,
        // Neither of the above undoes vi.stubGlobal or vi.stubEnv, so a test
        // file that forgets its own afterEach leaks a stubbed fetch into every
        // later test in that file - and the failure surfaces as an unrelated
        // test asserting against the wrong mock.
        unstubGlobals: true,
        unstubEnvs: true,
    },
});

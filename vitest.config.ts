import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        globals: true,
        include: ['scripts/__tests__/**/*.test.ts'],
    },
    resolve: {
        alias: {
            // `scripts/` is not a workspace package, so the root manifest's
            // dependency on `@copilotkit/outpost` is what creates a
            // node_modules/@copilotkit for it to resolve through. That alone
            // resolves to `shared/dist`, which means this suite would pass only
            // after a build and fail on a clean checkout with the same opaque
            // "Cannot find package" it was failing with before.
            //
            // Aliasing to source removes the build from the loop, and matches
            // what packages/outpost/vitest.config.ts already does for the same
            // specifier.
            '@copilotkit/outpost/shared': path.resolve(
                __dirname,
                'packages/outpost/shared/src/index.ts',
            ),
        },
    },
});

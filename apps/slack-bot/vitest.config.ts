import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            '@outpost/db': path.resolve(__dirname, '../../packages/db/src/index.ts'),
            '@outpost/queue': path.resolve(__dirname, '../../packages/queue/src/index.ts'),
            '@outpost/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts'],
        clearMocks: true,
    },
});

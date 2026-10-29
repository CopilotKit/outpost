import { defineConfig } from '@playwright/test';

/**
 * One end-to-end spec against the production web image (outpost#206). Not run in CI;
 * see apps/web/e2e/support.ts for how to build and select the image.
 */
export default defineConfig({
    testDir: './e2e',
    // Tests share one database and one mail sink, so they run one at a time, in order.
    workers: 1,
    fullyParallel: false,
    retries: 0,
    timeout: 60_000,
    reporter: [['list']],
    globalSetup: './e2e/global-setup.ts',
    globalTeardown: './e2e/global-teardown.ts',
    use: {
        baseURL: 'http://localhost:3100', // e2e web port (e2e/docker-compose.e2e.yml)
        trace: 'retain-on-failure',
    },
});

// @vitest-environment node
/**
 * Guards for outpost#253: email could not work in the production web image.
 *
 * The template tests pass from a checkout because the loader finds the repo-root
 * templates/ by walking up from cwd. The image has no checkout, so the runner stage
 * has to copy templates/ in itself. And the server bundle has to be able to load
 * postmark, because sendEmail is transpiled into it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import nextConfig from '../../next.config';

const repoRoot = path.resolve(__dirname, '../../../..');

function runnerStage(dockerfile: string): string[] {
    const lines = dockerfile.split('\n').map((l) => l.trim());
    const start = lines.findIndex((l) => /^FROM\s+\S+\s+AS\s+runner$/i.test(l));
    expect(start, 'apps/web/Dockerfile has no `AS runner` stage').toBeGreaterThanOrEqual(0);
    const rest = lines.slice(start + 1);
    const next = rest.findIndex((l) => /^FROM\s/i.test(l));
    return next === -1 ? rest : rest.slice(0, next);
}

describe('production web image: email', () => {
    it('copies templates/ into /app/templates in the runner stage', () => {
        const stage = runnerStage(
            readFileSync(path.join(repoRoot, 'apps/web/Dockerfile'), 'utf-8'),
        );

        const workdir = stage.find((l) => /^WORKDIR\s/i.test(l))?.split(/\s+/)[1];
        expect(workdir).toBe('/app');

        const copy = stage.find(
            (l) => /^COPY\s/i.test(l) && /\s\/app\/templates\/?\s/.test(`${l} `),
        );
        expect(copy, 'runner stage never copies /app/templates').toBeDefined();
        const dest = copy!.split(/\s+/).at(-1)!;
        expect(path.posix.resolve(workdir!, dest)).toBe('/app/templates');
    });

    it('has templates in the repo-root templates/ directory that the image copies', () => {
        const slugs = readdirSync(path.join(repoRoot, 'templates')).filter((f) =>
            f.endsWith('.md'),
        );
        expect(slugs).toContain('invite.md');
    });

    it('does not replace postmark with an empty module in the server bundle', () => {
        const config = { resolve: { alias: {} as Record<string, unknown> } };
        const webpack = nextConfig.webpack as (
            c: typeof config,
            o: { isServer: boolean },
        ) => typeof config;
        const out = webpack(config, { isServer: true });
        expect(out.resolve.alias.postmark).toBeUndefined();
    });
});

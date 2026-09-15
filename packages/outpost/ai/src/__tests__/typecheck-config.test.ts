import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * Guards the split between the typecheck config and the build config.
 *
 * The gap this exists for: excluding test material from `ai/tsconfig.json`
 * silently stops it being typechecked, because `typecheck` runs
 * `tsc --project ai/tsconfig.json --noEmit` against that same file. A test could
 * then assert against a shape that no longer exists and nothing would say so —
 * vitest exercises runtime behaviour, not types. It went unnoticed once already
 * and the failure mode leaves no trace, so it is worth a test rather than a
 * comment.
 *
 * Asserting on the config files is a blunt instrument, but the alternative —
 * running `tsc` from a test — is slow and would need the probe error committed.
 * This pins the property that matters: whatever `typecheck` reads must not
 * exclude tests, and the build config must.
 */

const packageRoot = join(import.meta.dirname, '..', '..');

/**
 * tsconfig files carry comments, which `JSON.parse` rejects.
 *
 * Uses TypeScript's own parser rather than stripping comments by hand. A
 * hand-rolled version got this wrong in a way worth recording: a block-comment
 * pattern matches inside these exclude values, because a doubled-star glob
 * followed by a slash-star extension reads as a comment opener, and the next
 * glob ending in slash-doubled-star reads as its closer. It ate the span between
 * them and collapsed three exclude patterns into one mangled string, so the test
 * failed against config that was correct.
 *
 * The globs are deliberately described rather than quoted here — writing them
 * literally inside a block comment closes it early, which broke this file once
 * for the same reason.
 */
function readTsconfig(path: string): Record<string, unknown> {
    const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
    if (error) throw new Error(`could not parse ${path}: ${JSON.stringify(error.messageText)}`);
    return config as Record<string, unknown>;
}

const TEST_PATTERNS = ['**/*.test.ts', '**/__tests__/**', '**/__fixtures__/**'];

describe('the config typecheck reads', () => {
    it('does not exclude test material, or tests stop being typechecked', () => {
        const exclude = (readTsconfig(join(packageRoot, 'tsconfig.json')).exclude ??
            []) as string[];

        for (const pattern of TEST_PATTERNS) {
            expect(exclude).not.toContain(pattern);
        }
    });
});

describe('the config the build reads', () => {
    it('excludes test material, so none of it reaches dist', () => {
        const cfg = readTsconfig(join(packageRoot, 'tsconfig.build.json'));
        const exclude = (cfg.exclude ?? []) as string[];

        // Inherits compilerOptions rather than restating them — the two configs
        // must not be able to drift on anything but `exclude`.
        expect(cfg.extends).toBe('./tsconfig.json');
        for (const pattern of TEST_PATTERNS) {
            expect(exclude).toContain(pattern);
        }
    });

    // A build script pointed at the inclusive config would put every test file
    // back into the published package, which is what this whole change removed.
    it('is what build:ai actually invokes', () => {
        const pkg = readTsconfig(join(packageRoot, '..', 'package.json'));
        const scripts = pkg.scripts as Record<string, string>;

        expect(scripts['build:ai']).toContain('ai/tsconfig.build.json');
        expect(scripts.typecheck).toContain('ai/tsconfig.json --noEmit');
    });
});

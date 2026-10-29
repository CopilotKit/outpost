/**
 * The SMTP transport imports nodemailer at runtime, so it must be a runtime dependency
 * of @copilotkit/outpost. If it moves to devDependencies or is dropped, the standalone
 * web image ships without it and every SMTP send fails to load (outpost#206).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const pkgPath = fileURLToPath(new URL('../../../../package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
    name: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
};

describe('email transport dependencies', () => {
    it('reads the @copilotkit/outpost manifest', () => {
        expect(pkg.name).toBe('@copilotkit/outpost');
    });

    it('lists nodemailer as a runtime dependency, not a dev dependency', () => {
        expect(pkg.dependencies?.nodemailer).toEqual(expect.any(String));
        expect(pkg.devDependencies?.nodemailer).toBeUndefined();
    });
});

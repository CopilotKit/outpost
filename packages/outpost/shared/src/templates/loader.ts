/**
 * Template loader.
 *
 * Loads a template by slug. Checks for a DB override first (via the
 * TemplateOverride model), falling back to the filesystem default
 * in the templates/ directory at the repo root.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { LoadedTemplate, TemplateMeta } from './types.js';

/** Parse frontmatter from a Markdown template string. */
export function parseFrontmatter(raw: string): { meta: TemplateMeta; body: string } {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
        return {
            meta: { name: '', subject: '', from: '' },
            body: raw.trim(),
        };
    }

    const frontmatterBlock = match[1];
    const body = match[2].trim();

    const meta: Record<string, string> = {};
    for (const line of frontmatterBlock.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();
        // Strip surrounding quotes
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        meta[key] = value;
    }

    return {
        meta: {
            name: meta.name || '',
            subject: meta.subject || '',
            from: meta.from || '',
        },
        body,
    };
}

/** Resolve the templates directory. Walks up from CWD looking for it. */
function findTemplatesDir(): string {
    // In production, templates are at the repo root /templates
    // We try a few known locations
    const candidates = [
        join(process.cwd(), 'templates'),
        join(process.cwd(), '..', 'templates'),
        join(process.cwd(), '..', '..', 'templates'),
        join(process.cwd(), '..', '..', '..', 'templates'),
    ];

    for (const dir of candidates) {
        try {
            readdirSync(dir);
            return dir;
        } catch {
            // not found, try next
        }
    }

    return join(process.cwd(), 'templates');
}

/** Load a template from the filesystem. Returns null if not found. */
export function loadFromFilesystem(slug: string): LoadedTemplate | null {
    const dir = findTemplatesDir();
    const filePath = join(dir, `${slug}.md`);

    try {
        const raw = readFileSync(filePath, 'utf-8');
        const { meta, body } = parseFrontmatter(raw);
        return { slug, meta, body, isOverride: false };
    } catch {
        return null;
    }
}

/**
 * Load a template by slug with optional DB override lookup.
 *
 * The dbLookup function is injected so the loader doesn't depend on Prisma
 * directly — callers pass in the DB query.
 */
export async function loadTemplate(
    slug: string,
    dbLookup?: (slug: string) => Promise<{ subject: string; body: string } | null>,
): Promise<LoadedTemplate | null> {
    // Check DB override first
    if (dbLookup) {
        const override = await dbLookup(slug);
        if (override) {
            const { meta, body: _fsBody } = (() => {
                const fs = loadFromFilesystem(slug);
                if (fs) return { meta: fs.meta, body: fs.body };
                return { meta: { name: slug, subject: '', from: '' }, body: '' };
            })();

            return {
                slug,
                meta: { ...meta, subject: override.subject },
                body: override.body,
                isOverride: true,
            };
        }
    }

    // Fall back to filesystem
    return loadFromFilesystem(slug);
}

/** List all available template slugs from the filesystem. */
/**
 * Whether `slug` names one of the templates that actually exist.
 *
 * The reason this exists rather than a path check: `loadFromFilesystem` builds
 * `join(dir, slug + '.md')` with no validation, and Next decodes percent-encoding
 * in a dynamic segment before a handler sees it — so `../docs/deployment` reaches
 * the loader as a traversal and reads the file. Verified against the real
 * function: `../README`, `../CLAUDE`, `../docs/deployment` and
 * `invite/../../README` all returned file contents, and the API route hands
 * `subject` and `body` back in its JSON response.
 *
 * An existence check does NOT close that, and this is the part worth being
 * explicit about: a guard shaped like `if (!loadFromFilesystem(slug))` SUCCEEDS
 * for every path above, so it approves the request it looks like it rejects. The
 * check performs the escape it appears to prevent.
 *
 * Membership in the real slug list is the property that holds, because a
 * traversal path is never a member however it is spelled. It also makes the
 * existence probes redundant — a slug that passed here is known to exist.
 *
 * Note the interaction with outpost#253: where `templates/` is absent from the
 * running image, this returns false for everything and callers 404. That is the
 * same behaviour those callers already had, and it fails in the safe direction.
 */
export function isKnownTemplateSlug(slug: string): boolean {
    return listTemplateSlugs().includes(slug);
}

export function listTemplateSlugs(): string[] {
    const dir = findTemplatesDir();
    try {
        return readdirSync(dir)
            .filter((f) => f.endsWith('.md'))
            .map((f) => f.replace(/\.md$/, ''));
    } catch {
        return [];
    }
}

import { describe, expect, it } from 'vitest';
import { SOURCES, lineOf } from '../sources.js';
import type { Release } from '../github.js';

const sourceFor = (name: string) => {
    const source = SOURCES.find((s) => s.name === name);
    if (!source) throw new Error(`no source named ${name}`);
    return source;
};

const filterFor = (name: string) => sourceFor(name).include;

const titleFor = (name: string, tag: string) =>
    sourceFor(name).title({ tag, name: tag } as Release);

describe('copilotkit', () => {
    const include = filterFor('copilotkit');

    it.each(['v1.73.0', 'v1.72.1', 'channels/v0.10.0', 'channels/v0.9.2', 'angular/v0.5.2'])(
        'announces %s',
        (tag) => {
            expect(include(tag)).toBe(true);
        },
    );

    it.each([
        // Active, but the notes are only a PyPI link.
        'python-sdk/v0.1.96',
        // Superseded by the channels/ umbrella, all last released 2026-07-10.
        'channels-teams/v0.1.2',
        'channels-slack/v0.1.1',
        // Moved to its own repo.
        'bot-slack/v0.1.0',
        // Version alignment only.
        'intelligence-mastra/v1.71.2',
        'intelligence-langgraph/v0.1.0',
        // Tags that exist in the repo and are not releases at all.
        'PR',
        'vundefined',
        'pr-6517-visuals',
    ])('skips %s', (tag) => {
        expect(include(tag)).toBe(false);
    });
});

describe('ag-ui', () => {
    const include = filterFor('ag-ui');

    it('announces a dated release', () => {
        expect(include('release/2026-09-17')).toBe(true);
    });

    it.each(['release/visual-qa', 'release/2026-9-1', 'v1.0.0'])('skips %s', (tag) => {
        expect(include(tag)).toBe(false);
    });
});

describe('openbot', () => {
    const include = filterFor('openbot');

    it.each(['v0.0.15', 'v0.0.8'])('announces %s', (tag) => {
        expect(include(tag)).toBe(true);
    });

    it.each(['desktop/v0.0.15', 'nightly'])('skips %s', (tag) => {
        expect(include(tag)).toBe(false);
    });
});

describe('titles', () => {
    it.each([
        ['copilotkit', 'v1.73.0', 'CopilotKit 1.73.0'],
        ['copilotkit', 'channels/v0.10.0', 'Channels SDK 0.10.0'],
        ['copilotkit', 'angular/v0.5.2', 'Angular SDK 0.5.2'],
        ['openbot', 'v0.0.15', 'OpenBot 0.0.15'],
        ['ag-ui', 'release/2026-09-17', 'AG-UI 2026-09-17'],
    ])('names the product for %s %s', (source, tag, expected) => {
        // Sources share a channel, so a bare version number would not say which
        // product shipped.
        expect(titleFor(source, tag)).toBe(expected);
    });
});

describe('lineOf', () => {
    it.each([
        ['v1.73.0', ''],
        ['channels/v0.10.0', 'channels'],
        ['angular/v0.5.2', 'angular'],
        ['release/2026-09-17', 'release'],
        // lastIndexOf, not indexOf: a multi-segment tag belongs to its full
        // prefix, and splitting on the first slash would compare it against an
        // unrelated line.
        ['a/b/v1.0.0', 'a/b'],
    ])('reads %s as line %s', (tag, line) => {
        expect(lineOf(tag)).toBe(line);
    });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isShadowMode } from '../shadow-mode.js';

describe('isShadowMode', () => {
    let original: string | undefined;
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        original = process.env.SHADOW_MODE;
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        if (original === undefined) delete process.env.SHADOW_MODE;
        else process.env.SHADOW_MODE = original;
        warn.mockRestore();
    });

    const set = (value: string | undefined) => {
        if (value === undefined) delete process.env.SHADOW_MODE;
        else process.env.SHADOW_MODE = value;
    };

    it('is off when the variable is not set', () => {
        set(undefined);
        expect(isShadowMode()).toBe(false);
        // Shadow mode is opt-in: defaulting an absent variable to ON would make a
        // fresh deployment silently answer nobody.
        expect(warn).not.toHaveBeenCalled();
    });

    // The regression this module exists for. Every one of these read as
    // "not shadow mode" under `=== 'true'` and posted to real Discord and GitHub
    // surfaces — a safety flag failing open on values an operator would
    // reasonably expect to work.
    it.each(['TRUE', 'True', '1', 'yes', 'YES', 'on', 'ON', ' true ', 'tRuE'])(
        'treats %j as ON, recognized rather than guessed',
        (value) => {
            set(value);
            expect(isShadowMode()).toBe(true);
            // Asserting the absence of the warning is what pins EXPLICITLY_ON.
            // On the boolean alone, shrinking the set to `['true']` left all of
            // these passing — a dropped member still comes back `true` through
            // the fail-closed branch, just for the wrong reason and with a
            // spurious warning. This also pins `.trim()` and `.toLowerCase()`,
            // which were each held down by exactly one OFF case.
            expect(warn).not.toHaveBeenCalled();
        },
    );

    it.each(['false', 'FALSE', '0', 'no', 'off'])('treats %j as OFF', (value) => {
        set(value);
        expect(isShadowMode()).toBe(false);
        expect(warn).not.toHaveBeenCalled();
    });

    // A cleared value is still a value that IS set, so it takes the same
    // fail-closed path as any other unclear instruction. A declared-but-empty
    // Railway variable, or a `.env` line with nothing after the `=`, used to
    // read as "post for real" silently; it now stops the bot and says why.
    it.each(['', '  '])('treats the cleared value %j as ON, and says so', (value) => {
        set(value);
        expect(isShadowMode()).toBe(true);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain(JSON.stringify(value));
    });

    // Anything set but unrecognized is an operator trying to say something. The
    // safe reading of an unclear instruction is the one that posts nothing.
    it.each(['maybe', 'shadow', 'enabled', '2', 'null', 'undefined'])(
        'fails CLOSED on the unrecognized value %j, and says so',
        (value) => {
            set(value);
            expect(isShadowMode()).toBe(true);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0][0])).toContain(JSON.stringify(value));
        },
    );

    it('does not warn on values it recognizes either way', () => {
        set('true');
        expect(isShadowMode()).toBe(true);
        set('false');
        expect(isShadowMode()).toBe(false);
        expect(warn).not.toHaveBeenCalled();
    });
});

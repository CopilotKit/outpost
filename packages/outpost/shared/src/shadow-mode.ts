/**
 * Whether Outpost is running in shadow mode.
 *
 * Shadow mode is a safety flag: when it is on, AI responses are generated and
 * recorded but never posted to a real community surface. It exists so Outpost
 * can run in parallel with an incumbent without double-posting at reporters.
 *
 * The comparison is the whole point of this module. Every call site used to be
 * `process.env.SHADOW_MODE === 'true'`, which means `SHADOW_MODE=TRUE`,
 * `SHADOW_MODE=1` and `SHADOW_MODE=yes` all read as "not shadow mode" and post
 * to Discord and GitHub for real. That is a safety flag failing OPEN on inputs
 * an operator would reasonably expect to work — the direction a safety flag must
 * never fail.
 *
 * So every value that IS set fails CLOSED instead: recognized off values are
 * off, recognized on values are on, and anything else is treated as ON and
 * logged. The asymmetry is deliberate. A false positive costs a parallel-run
 * window where nothing is posted and someone notices from the logs; a false
 * negative posts machine-generated text at real people under a flag that was
 * meant to prevent exactly that.
 *
 * `SHADOW_MODE` being ABSENT is the one exception and it means off, because a
 * fresh deployment defaulting to ON would silently answer nobody. That
 * exception is stated here rather than only on the function, because a reader
 * who skims this header and concludes a missing variable is the safe case has
 * formed exactly the belief this module exists to kill.
 */

/**
 * Values that mean "off". Everything else that is set means "on".
 *
 * `''` is deliberately NOT here. A declared-but-cleared Railway variable, or a
 * `.env` line with nothing after the `=`, is a value that IS set — so by this
 * module's own rule it is an operator trying to say something unclear, and the
 * safe reading of that is the one that posts nothing. It falls through to the
 * unrecognized branch, which turns shadow mode on and says so. The cost is a
 * cleared variable stopping the bot instead of starting it, which is the side
 * of that trade this module exists to take.
 */
const EXPLICITLY_OFF = new Set(['false', '0', 'no', 'off']);

/** Values that mean "on" without comment. Others are honored but logged. */
const EXPLICITLY_ON = new Set(['true', '1', 'yes', 'on']);

/**
 * True when shadow mode is engaged.
 *
 * Unset means off — shadow mode is opt-in, and defaulting an absent variable to
 * ON would make a fresh deployment silently answer nobody. The fail-closed rule
 * applies to values that ARE set: those are an operator trying to say something,
 * and the safe reading of an unclear instruction is the one that posts nothing.
 */
export function isShadowMode(): boolean {
    const raw = process.env.SHADOW_MODE;
    if (raw === undefined) return false;

    const normalized = raw.trim().toLowerCase();
    if (EXPLICITLY_OFF.has(normalized)) return false;
    if (EXPLICITLY_ON.has(normalized)) return true;

    // Set to something we do not recognize. Treated as ON, and said out loud —
    // silently guessing either way is how the original bug survived.
    console.warn(
        `[Shadow Mode] SHADOW_MODE is set to an unrecognized value ${JSON.stringify(raw)}; ` +
            'treating it as ON so nothing is posted to a real community surface. ' +
            'Use true/false (or 1/0, yes/no, on/off) to be explicit.',
    );
    return true;
}

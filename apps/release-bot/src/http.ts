/**
 * Shared fetch concerns.
 *
 * Node's fetch has no default timeout, and this runs as a cron container with a
 * restart policy of NEVER: one hung socket would leave the run alive until a
 * later scheduled run overlapped it, and two concurrent runs reading the same
 * channel can both decide the same release is unannounced.
 */

export const TIMEOUT_MS = 20_000;

/** Parses a JSON body, naming the service when the body turns out not to be JSON. */
export async function parseJson<T>(res: Response, what: string): Promise<T> {
    const text = await res.text();
    try {
        return JSON.parse(text) as T;
    } catch (cause) {
        throw new Error(`${what} returned a non-JSON body: ${text.slice(0, 200)}`, { cause });
    }
}

/** Attempts, not retries: 3 means one call and two more tries. */
export const MAX_ATTEMPTS = 3;

/** Ceiling on any honoured `retry-after`, so a long one cannot hang the run. */
export const MAX_RETRY_WAIT_MS = 60_000;

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const backoff = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS);

/**
 * How long to wait before retrying, from the response.
 *
 * `retry-after` is in seconds and gets a small grace period: honoured to the
 * exact millisecond, a `retry-after: 1` retried at t+1000ms trips the same
 * limit again. GitHub signals its primary rate limit with `x-ratelimit-reset`
 * (epoch seconds) and no `retry-after` at all, so that is read too - without
 * it, a rate-limited run burns every attempt inside three seconds against a
 * limit that resets minutes later.
 *
 * The body is cancelled on every path: under undici an unread body holds its
 * connection out of the pool until garbage collection.
 */
export function retryAfterMs(res: Response): number | undefined {
    void res.body?.cancel().catch(() => {});

    const header = res.headers.get('retry-after');
    if (header) {
        const seconds = Number(header);
        // The header also admits an HTTP date, which Number() reads as NaN.
        // Positive, not merely finite: a negative retry-after produced a
        // negative delay, and pause() on that fires on the next tick - turning
        // the backoff into an immediate hammer at the provider.
        if (Number.isFinite(seconds) && seconds > 0) {
            return Math.min(seconds * 1000 + 100, MAX_RETRY_WAIT_MS);
        }
    }

    if (res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        if (Number.isFinite(reset)) {
            const wait = reset * 1000 - Date.now();
            if (wait > 0) return Math.min(wait + 100, MAX_RETRY_WAIT_MS);
        }
    }

    return undefined;
}

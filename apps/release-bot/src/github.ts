/**
 * GitHub source: new releases, plus the context needed to write about them.
 *
 * Release notes alone are not enough. CopilotKit's are often one sentence, and
 * AG-UI's are thousands of characters of package tables. So for every release we
 * also pull the commits since the previous release, which is the real list of
 * what shipped.
 */

import { MAX_ATTEMPTS, TIMEOUT_MS, backoff, parseJson, pause, retryAfterMs } from './http.js';

const API = 'https://api.github.com';

/**
 * Pages of 100 releases to walk back through: within the lookback window for
 * listReleases, and in total for previousRelease, which has no window.
 */
const RELEASE_PAGES = 5;

/** Pages of 100 commits to read from a compare range. */
const COMPARE_PAGES = 10;

export type Release = {
    repo: string;
    tag: string;
    name: string;
    url: string;
    body: string;
    publishedAt: string;
};

export type ReleaseContext = Release & {
    /** Subjects worth showing a reader, noise removed. */
    commits: string[];
    /**
     * True when the compare was answered completely: GitHub said the tags are
     * identical, or every commit it reported was actually read.
     *
     * Distinguishes "there is nothing between these tags" and "here is all of
     * it" from "we could not ask" and "we got part of it", all of which look
     * alike in `commitsRead` alone. This is the only field a caller may use to
     * decide the commit list is authoritative.
     */
    comparedCleanly?: boolean;
    /**
     * How many commits the compare returned before filtering.
     *
     * Zero read means there was nothing to look at (no previous release, or a
     * compare that failed), while zero kept out of many read means the release
     * was dependency bumps and version chores. This alone does not license a
     * skip: a partial read also has commits read. `comparedCleanly` does.
     */
    commitsRead: number;
};

/** Only the fields this app reads, not the full GitHub payloads. */
type GhRelease = {
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
    tag_name: string;
    name: string | null;
    html_url: string;
    body: string | null;
};

type GhCommit = {
    commit: { message: string };
};

type GhCompare = {
    status?: 'diverged' | 'ahead' | 'behind' | 'identical';
    commits?: GhCommit[];
    total_commits?: number;
};

function headers() {
    const token = process.env.GITHUB_TOKEN;
    // Unauthenticated, GitHub allows 60 requests an hour, so the run would die
    // partway through with an opaque 403.
    // Failing here names the actual problem instead.
    if (!token) {
        throw new Error(
            'GITHUB_TOKEN is not set. Unauthenticated requests are rate limited to 60 an hour.',
        );
    }
    return {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'copilotkit-release-bot',
        Authorization: `Bearer ${token}`,
    };
}

/**
 * A GitHub read, with bounded retries.
 *
 * Reads are retried for the same reason Discord's are: a secondary rate limit
 * or a 502 on one of several calls per run would otherwise fail a whole source.
 */
async function gh<T>(path: string): Promise<T> {
    // Outside the loop, so a missing token throws rather than being tolerated
    // as though it were an HTTP failure. A config error is not a bad network.
    const requestHeaders = headers();

    for (let attempt = 1; ; attempt++) {
        const last = attempt >= MAX_ATTEMPTS;

        let res: Response;
        try {
            res = await fetch(`${API}${path}`, {
                headers: requestHeaders,
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (error) {
            if (last) throw error;
            await pause(backoff(attempt));
            continue;
        }

        if (res.ok) return parseJson<T>(res, 'GitHub');

        // 403 only when the headers say it is a rate limit. GitHub uses the same
        // status for a revoked token and a repo the token cannot see, and those
        // cost three attempts and three seconds of sleep before surfacing an
        // error no amount of retrying fixes.
        //
        // Both limits count. The primary one zeroes x-ratelimit-remaining; the
        // secondary abuse-detection one leaves it above zero and sends
        // retry-after instead, so keying on the counter alone stopped retrying
        // the single 403 that tells us exactly how long to wait.
        const rateLimited =
            res.status === 429 ||
            (res.status === 403 &&
                (res.headers.get('x-ratelimit-remaining') === '0' ||
                    res.headers.has('retry-after')));

        if ((rateLimited || res.status >= 500) && !last) {
            // Via the shared helper, which also reads x-ratelimit-reset. GitHub
            // sends no retry-after on a primary rate limit, so the local version
            // of this burned every attempt inside three seconds against a limit
            // that resets minutes later.
            const wait = retryAfterMs(res) ?? backoff(attempt);
            await pause(wait);
            continue;
        }
        throw new GhError(
            res.status,
            `GitHub ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`,
        );
    }
}

/**
 * A GitHub failure that carries its status as data.
 *
 * `contextFor` needs to recognise a 404 to degrade rather than fail the source.
 * It used to do that with `error.message.includes('GitHub 404')` - against a
 * message that embeds the first 200 characters of the response body. Any other
 * failure whose body happened to contain that literal (a proxy error page, a
 * gateway echoing an upstream error) was silently reclassified as a deleted tag,
 * and the release was announced with no commit context while the log asserted a
 * cause that was not true. The status is structured at the throw site; flattening
 * it into prose and re-parsing it was the whole bug.
 */
export class GhError extends Error {
    override readonly name = 'GhError';
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

/**
 * Releases published since `since`, oldest first.
 *
 * Paginates rather than reading one page: the API orders by creation, not
 * publication, and a busy week of per-package releases pushed main-line releases
 * out of a single 30-item page while they were still inside the lookback window.
 * A release that falls out of the window is not deferred, it is lost, because the
 * watermark has already moved past it.
 */
export async function listReleases(repo: string, since: string): Promise<Release[]> {
    const collected: Release[] = [];
    const seen = new Set<string>();
    const cutoff = Date.parse(since);
    // True only while every page read has been full and in-window, which is the
    // one case where releases can still be hiding past the last page.
    let hitPageLimit = true;

    for (let page = 1; page <= RELEASE_PAGES; page++) {
        const batch = await gh<GhRelease[]>(`/repos/${repo}/releases?per_page=100&page=${page}`);
        // gh() guarantees the body parsed as JSON, not that it is an array. A
        // 200 carrying an object - a proxy or gateway envelope - gives
        // `batch.length === undefined`, which read as an empty page: the loop
        // broke on page 1 with nothing collected, no warning, and the run exited
        // 0. That is the cron-reports-success failure this bot exists to avoid,
        // so it throws, the way youtube.ts throws on a feed whose entries
        // will not parse.
        if (!Array.isArray(batch)) {
            throw new Error(
                `${repo}: /releases page ${page} returned ${typeof batch}, not an array. ` +
                    'The API response shape changed, or something is answering for it.',
            );
        }
        // An empty page is the end of the list, not a truncated read: leaving
        // the flag set here made a repo with no releases at all, or with
        // exactly 100 of them, raise the "releases are being lost" alarm.
        if (!batch.length) {
            hitPageLimit = false;
            break;
        }

        for (const r of batch) {
            if (r.draft || r.prerelease || !r.published_at) continue;
            // GitHub orders /releases by creation, so a release published between
            // two page fetches shifts the window and the last entry of page N
            // comes back as the first of page N+1. Undeduped, both reach
            // pending() as distinct objects with the same url and both post.
            if (seen.has(r.html_url)) continue;
            seen.add(r.html_url);
            // By instant, not by string: `since` carries milliseconds and
            // GitHub's timestamps do not, so a lexicographic compare disagrees
            // inside the boundary second.
            // Excluded outright, not compared: `NaN <= cutoff` is false, so an
            // unreadable timestamp used to fall through into `collected`.
            // pending() then drops it, but it stays in `releases`, where
            // previousOnLine() can pick it as a compare baseline and the
            // publish-order comparator returns NaN for every pair touching it.
            if (!Number.isFinite(Date.parse(r.published_at))) {
                console.warn(
                    `${repo}: unreadable published_at "${r.published_at}" on ${r.tag_name}`,
                );
                continue;
            }
            if (Date.parse(r.published_at) <= cutoff) continue;
            collected.push({
                repo,
                tag: r.tag_name,
                name: r.name || r.tag_name,
                url: r.html_url,
                body: r.body || '',
                publishedAt: r.published_at,
            });
        }

        // Ordering is by creation, so only stop once a whole page is older than
        // the window rather than on the first old entry.
        //
        // Undated entries are ignored rather than counted as old. A draft has no
        // published_at and GitHub clusters drafts at the top by creation date, so
        // treating them as old let one full page of drafts end pagination on page
        // 1 - and every in-window release behind it was lost, not deferred, since
        // the watermark then moves past what was never read. A page with nothing
        // dated on it says nothing about the window, so it does not stop the walk.
        const published = batch
            .map((r) => r.published_at)
            .filter((at): at is string => Boolean(at));
        const allOlder = published.length > 0 && published.every((at) => Date.parse(at) <= cutoff);
        if (allOlder || batch.length < 100) {
            hitPageLimit = false;
            break;
        }
    }

    // Anything still inside the window but past this many pages is invisible,
    // and invisible means lost rather than deferred once the watermark moves.
    // This is the only signal of that, so it must not cry wolf.
    if (hitPageLimit) {
        console.warn(`${repo}: more than ${RELEASE_PAGES} pages of releases inside the window`);
    }

    // Ties need an explicit second key. GitHub returns releases newest-created
    // first, so a stable sort leaves same-instant releases reversed relative to
    // everything around them, and the caller takes the previous element as the
    // compare baseline: for a tie that baseline is NEWER than the release, the
    // compare comes back ahead_by 0, and the release is announced with no commits
    // without anything failing. AG-UI really does publish
    // several releases within the same second (see watermark.ts). Reversing
    // arrival order within a tie restores creation order, oldest first.
    return collected
        .map((release, index) => ({ release, index }))
        .sort(
            (a, b) =>
                Date.parse(a.release.publishedAt) - Date.parse(b.release.publishedAt) ||
                b.index - a.index,
        )
        .map(({ release }) => release);
}

/**
 * The release published most recently before `release` whose tag `matches`,
 * with no time limit. Undefined when there is none in the pages read.
 *
 * The caller first looks for a baseline among the releases it already fetched,
 * and those stop at the lookback window. A line that ships less often than that
 * - the Angular SDK after a quiet month - then found no previous release, so its
 * next release was summarized from the notes alone, with no commits. That also
 * made a dependency-bump release on such a line impossible to skip, because a
 * SKIP is only trusted when the commits back it up. This is the lookup for that
 * case, and only that case.
 *
 * Every page is scanned, not just until the first match. /releases is ordered by
 * creation rather than publication, so the first match is not reliably the most
 * recent one. The walk stops on the page after the one where a match turns up,
 * once that page holds nothing published after it - usually two or three reads.
 * A line with no earlier release at all reads every page up to RELEASE_PAGES,
 * and says so.
 */
export async function previousRelease(
    release: Release,
    matches: (tag: string) => boolean,
): Promise<Release | undefined> {
    const before = Date.parse(release.publishedAt);
    let best: Release | undefined;

    for (let page = 1; page <= RELEASE_PAGES; page++) {
        const batch = await gh<GhRelease[]>(
            `/repos/${release.repo}/releases?per_page=100&page=${page}`,
        );
        if (!Array.isArray(batch)) {
            throw new Error(
                `${release.repo}: /releases page ${page} returned ${typeof batch}, not an array.`,
            );
        }
        // The end of the list, so "none found" here is true, not a guess.
        if (!batch.length) return best;

        for (const r of batch) {
            if (r.draft || r.prerelease || !r.published_at) continue;
            if (r.tag_name === release.tag || !matches(r.tag_name)) continue;
            const at = Date.parse(r.published_at);
            if (!Number.isFinite(at) || at >= before) continue;
            if (!best || at > Date.parse(best.publishedAt)) {
                best = {
                    repo: release.repo,
                    tag: r.tag_name,
                    name: r.name || r.tag_name,
                    url: r.html_url,
                    body: r.body || '',
                    publishedAt: r.published_at,
                };
            }
        }

        if (best) {
            const floor = Date.parse(best.publishedAt);
            const anyNewer = batch.some(
                (r) => r.published_at && Date.parse(r.published_at) > floor,
            );
            if (!anyNewer) break;
        }
        if (batch.length < 100) return best;
    }

    if (!best) {
        // Only reached when every page was full: the list goes on past what was
        // read, so "none" here means "none in the last 500", not "none at all".
        console.warn(
            `${release.tag}: no earlier release on its line in the last ${RELEASE_PAGES * 100} ` +
                'releases; announcing without commit context.',
        );
    }
    return best;
}

/**
 * Commit subjects that say nothing a reader of the announcement would care about.
 *
 * `fix(deps)` is deliberately absent, unlike `chore(deps)` and `build(deps)`. It
 * is the one dependency scope that routinely carries CVE work, and filtering it
 * emptied `commits` on a security-patch release - which is exactly the condition
 * that rubber-stamps a model SKIP, so the release posted nothing and the
 * watermark moved past it.
 */
const NOISE =
    /^((chore|build|ci|test|docs)\((deps|deps-dev|release)\)|chore\(release\)|chore:\s*(bump|release)\b|release:|(ci|test|docs|style)[(:])/i;

/**
 * Git's own merge subjects, matched case-sensitively and by full shape.
 *
 * A bare case-insensitive `Merge ` dropped real work: `merge sort: faster path`
 * is a commit about sorting, and filtering it lost the change from the summary.
 */
const MERGE = /^Merge (branch|pull request|remote-tracking branch|tag|commit) /;

/**
 * The commits between the previous release and this one.
 *
 * `previous` is chosen by the caller, which is the only place that knows how a
 * repo's tag lines are shaped. Not `GET /tags`: that list is ordered by refname,
 * carries junk tags (`vundefined` sorts above `v1.73.0`) and mixes per-package
 * tags together, so `tags[index + 1]` is routinely a baseline from an unrelated
 * line. Comparing across lines is silent - GitHub answers 200 with a plausible
 * commit set - and the summary then describes a different release.
 */
export async function contextFor(release: Release, previous?: Release): Promise<ReleaseContext> {
    if (!previous) {
        console.warn(
            `${release.tag}: no previous release found on its line, announcing without commit context`,
        );
        return { ...release, commits: [], commitsRead: 0 };
    }

    const range = `${encodeURIComponent(previous.tag)}...${encodeURIComponent(release.tag)}`;

    let first: GhCompare;
    try {
        first = await gh<GhCompare>(`/repos/${release.repo}/compare/${range}?per_page=100`);
    } catch (error) {
        // A deleted or re-pushed tag 404s here. Every other way of not getting a
        // commit list degrades - no previous release, a non-ahead compare - so
        // this one should too. Throwing failed the source on every run until the
        // release aged out of the window and was lost rather than deferred.
        if (!(error instanceof GhError) || error.status !== 404) throw error;

        console.warn(
            `${release.tag}: comparing against ${previous.tag} returned 404, ` +
                'probably a deleted tag. Announcing without commit context.',
        );
        return { ...release, commits: [], commitsRead: 0 };
    }

    // A baseline that is not this release's predecessor answers 200 with
    // `behind` or `diverged` and an empty commit set, which is indistinguishable
    // from "first release on this line" once it reaches the caller. A backport
    // does exactly this: v1.72.5 shipped after v1.73.0 compares backwards.
    // `identical` is asked-and-answered: GitHub compared the two tags and there
    // is genuinely nothing between them. That corroborates a skip, so it must
    // not be conflated with `behind`/`diverged`, where the baseline was simply
    // the wrong tag - those return commitsRead 0, which forces a second
    // completion and then announces a release with no commits at all.
    if (first.status === 'identical') {
        return { ...release, commits: [], commitsRead: 0, comparedCleanly: true };
    }

    if (first.status && first.status !== 'ahead') {
        console.warn(
            `${release.tag}: compare against ${previous.tag} came back "${first.status}", ` +
                'not "ahead". Announcing without commit context.',
        );
        return { ...release, commits: [], commitsRead: 0 };
    }

    const all = [...(first.commits ?? [])];
    // Without a total there is no way to know the list is whole, so the read is
    // never reported as complete below. Falling back to all.length on its own
    // made `comparedCleanly` true here: a first page that happened to be all
    // noise then corroborated a SKIP, and a real release went unannounced.
    const knowsTotal = first.total_commits !== undefined;
    if (!knowsTotal) {
        console.warn(
            `${release.tag}: compare returned no total_commits; ` +
                'the commit list may be truncated at one page.',
        );
    }
    const total = first.total_commits ?? all.length;

    // The compare endpoint returns oldest first, so without paging the newest
    // work in a large release is simply absent from the summary.
    //
    // When the range is longer than COMPARE_PAGES can hold, the pages read are
    // the LAST ones, not the next ones. This is a monorepo: channels/v0.10.0 to
    // v0.11.0 was 625 commits in a week, so a gap of a few weeks is thousands.
    // Paging forward from page 2 then read only the oldest thousand, and the
    // summary's "newest 60" were really the newest of the oldest - work from
    // weeks before the release, presented as what it shipped. The API serves
    // any page directly (verified: page 13 of a 1248-commit range), so jumping
    // to the end costs nothing extra. Page 1 stays in `all` as the oldest
    // slice, which the summary never reaches because it takes from the end.
    const lastPage = Math.ceil(total / 100);
    const firstTailPage = Math.max(2, lastPage - (COMPARE_PAGES - 1) + 1);
    for (let page = firstTailPage; page <= lastPage; page++) {
        // Degrade rather than fail, the same as a 404 on page 1. A tag deleted
        // between two page fetches, a 502 on page 7, or a secondary limit that
        // outlives MAX_ATTEMPTS used to throw out of contextFor and fail the
        // whole source, discarding the commits already read - when the
        // incomplete-list warning below is exactly the right response.
        let batch: GhCompare['commits'];
        try {
            batch = (
                await gh<GhCompare>(
                    `/repos/${release.repo}/compare/${range}?per_page=100&page=${page}`,
                )
            ).commits;
        } catch (error) {
            // Carry on to the next page rather than stopping. A 502 on page 2
            // says nothing about page 3, and breaking here threw away every page
            // after it: on a 625-commit release one transient failure dropped
            // 525 commits instead of 100, and the summary was then written from
            // the OLDEST hundred while claiming to describe the newest work.
            console.warn(`${release.tag}: compare page ${page} failed: ${error}`);
            continue;
        }
        if (!batch?.length) break;
        all.push(...batch);
    }

    // Whether the commit list is complete, which is not the same question as
    // whether any commits were read. A partial read used to be indistinguishable
    // from a complete one, and `summarize` treats "commits were read and none
    // survived the noise filter" as corroboration for a SKIP - so a 16%-complete
    // read whose visible commits happened to be all noise rubber-stamped a skip,
    // and a skipped release leaves no trace in the channel for the next run to
    // reconsider. Lost, not deferred.
    const comparedCleanly = knowsTotal && all.length >= total;

    if (!comparedCleanly) {
        console.warn(
            `${release.tag}: read ${all.length} of ${total} commits; ` +
                'the summary is written from an incomplete list.',
        );
    }

    const commits = all
        .map((c) => c.commit.message.split('\n')[0])
        .filter((subject) => !NOISE.test(subject) && !MERGE.test(subject));

    return { ...release, commits, commitsRead: all.length, comparedCleanly };
}

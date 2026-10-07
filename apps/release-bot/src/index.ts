/**
 * One pass: look at what each channel already says, find what shipped since,
 * announce the difference.
 *
 * The channel is the source of truth. Every announcement ends with its source
 * URL, so "have we said this already" is answered by reading the bot's own
 * recent messages rather than by trusting a file to still be accurate.
 *
 * Run it on any schedule. Running it twice in a row posts nothing the second
 * time, and a crash halfway through a batch cannot cause a repeat.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { listReleases, contextFor, previousRelease, type Release } from './github.js';
import { listVideos, type Video } from './youtube.js';
import { summarize } from './summarize.js';
import { announce, announced, compose, postText, withPing, type Announced } from './discord.js';
import { pending } from './watermark.js';
import { SOURCES, lineOf, type Source } from './sources.js';

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * How far back to look for things to announce.
 *
 * This also bounds the watermark. If the last announced item is older than the
 * window, the run cannot see it: with something of this source's still visible
 * in the channel it falls back to the channel-history floor, and with nothing
 * visible at all it announces the newest item alone. `foundOwn` decides which,
 * and it is checked before the floor is - see `pending()`.
 */
const LOOKBACK_DAYS = 30;

/**
 * Most announcements *posted* per source per run. A source that has been off for
 * a fortnight catches up over several runs instead of emptying its backlog into
 * the channel at once. Two sources pointed at one channel can each post this
 * many.
 *
 * Counted on posts, not on candidates: a skipped release leaves no trace in the
 * channel, so when skips consumed the budget two skippable releases in a row
 * stalled a source until they aged out of the window.
 */
const MAX_PER_RUN = 2;

/**
 * A runaway guard on how many releases one run will examine, not a working
 * limit. Reaching it is an anomaly and says so in the log.
 *
 * It is deliberately far above the real backlog. A skip leaves no trace in the
 * channel, so it never advances the watermark and the same releases are
 * reconsidered next run. At 10 that was a trap rather than a budget: ten
 * skippable releases at the head of the backlog filled the window on every run
 * for ever, and everything behind them was never reached - lost when it aged
 * out rather than deferred. That is the same stall MAX_PER_RUN was moved off
 * candidates to fix, reintroduced one level up.
 *
 * Skipped releases are reconsidered every run until they age out of the window,
 * since a skip leaves nothing in the channel. That is free when the commits
 * decide it, which is the common case: summarize() skips those before calling
 * the model. It costs completions only for a release the model insists on
 * skipping against the commits, which is rare.
 */
const MAX_CONSIDERED = 100;

/**
 * How long one run may spend before deferring the rest to the next one.
 *
 * MAX_CONSIDERED is a runaway guard, not a time bound: every candidate costs a
 * compare (up to COMPARE_PAGES calls) and a completion, and one release can cost
 * two completions because an uncorroborated SKIP is re-asked - so up to
 * 2 × MAX_ATTEMPTS × MODEL_TIMEOUT_MS, nine minutes, on a single release. A
 * large backlog against a slow provider could run for hours and overlap the next
 * scheduled run, and two runs reading the same channel can both decide the same
 * release is unannounced, which is the hazard `http.ts` opens by explaining.
 *
 * The deadline is computed once in `main()` and passed down, so it bounds the
 * whole run. Held per source it bounded nothing: each source got its own fresh
 * budget and the real ceiling was a multiple of this.
 *
 * It is checked between releases, not inside one, so it stops new work from
 * starting rather than cutting a run off. The release in flight when it passes
 * keeps going: the completions above, plus its GitHub pages, each with retries
 * and waits, so a run where every dependency is failing at once can take longer.
 * Railway does not start a scheduled run while the previous one is active, so
 * that delays the next run rather than overlapping it.
 *
 * Deferring is free here: the watermark does not move for work not done, so the
 * next run picks up exactly where this one stopped.
 */
const RUN_BUDGET_MS = 20 * 60_000;

function lookback(): string {
    return new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString();
}

/** A configuration fault: stop the whole run rather than the current source. */
export class Misconfigured extends Error {
    override readonly name = 'Misconfigured';
}

/**
 * A missing credential, which Discord and GitHub signal by throwing. OpenAI
 * reaches the same place by a different route - `summarize()` returns
 * `disposition: 'abort'` and the caller constructs `Misconfigured` directly, so
 * its variable is deliberately absent here: the message is prefixed with the
 * release tag by then, and this pattern is anchored.
 *
 * Matched on the message rather than a type so discord.ts and github.ts stay
 * free of a dependency on this module.
 */
const MISCONFIGURED = /^(DISCORD_BOT_TOKEN|GITHUB_TOKEN) is not set/;

/**
 * The previous release on the same tag line, or undefined if this is the first
 * one in the window.
 *
 * Exported for tests: the interleaving this guards against is invisible in a
 * single-line repo and only shows up once a source admits more than one line.
 */
export function previousOnLine<T extends { tag: string }>(releases: T[], release: T) {
    const at = releases.indexOf(release);
    // Not present is -1, and slice(0, -1) means "all but the last" rather than
    // "nothing" - so the miss returned a plausible, newer baseline.
    if (at < 0) return undefined;

    const line = lineOf(release.tag);
    return releases
        .slice(0, at)
        .reverse()
        .find((r) => lineOf(r.tag) === line);
}

/**
 * What is pending for a source, grouped by tag line.
 *
 * Per tag line, not per source. `pending()` takes the newest announced item as
 * its watermark, and one repo publishes several independent sequences - so
 * announcing v1.73.0 set a watermark above channels/v0.10.1 published an hour
 * earlier, and that release was dropped for good rather than deferred. The
 * design was already half per-line, in previousOnLine; this is the other half.
 *
 * `foundOwn` is narrowed with the grouping. It arrives scoped to the source, so
 * a line that has never been announced would otherwise inherit `true` from a
 * sibling line and skip pending()'s announce-only-the-newest guard. Reachable
 * without any config change: three lines and MAX_PER_RUN of 2 leaves the third
 * line in exactly that state on the second run.
 *
 * The narrowing has a cost, and it is worth being honest about which way it
 * runs. A line whose last announcement is not in the history read gets
 * `foundOwn: false`, and that branch keeps only the newest item and discards the
 * rest of the line permanently. The inherited-`true` alternative would instead
 * take the `searchedFrom` floor branch, which is bounded by the history read.
 * So this trade is only safe while the history read covers the announce window,
 * which is why `announced()` takes the lookback and pages until it reaches past
 * it rather than stopping at a fixed number of messages.
 *
 * Exported so the tests pin this rather than a copy of it. A test that
 * reimplemented the grouping stayed green with the grouping deleted.
 */
export function planBacklog(releases: Release[], seen: Announced, ours: string): Release[] {
    const lines = new Map<string, Release[]>();
    for (const release of releases) {
        const line = lineOf(release.tag);
        const group = lines.get(line);
        if (group) group.push(release);
        else lines.set(line, [release]);
    }

    // The tag is whatever follows `/tag/`. GitHub does NOT percent-encode the
    // slash in html_url - it returns `.../releases/tag/channels/v0.11.0`
    // literally - so the decode below is for robustness against an encoded form
    // arriving from anywhere else, not because GitHub sends one. Either shape
    // reduces to the same line, since lineOf splits on the last slash.
    //
    // A miss returns undefined rather than garbage. `lastIndexOf` gives -1, and
    // `slice(-1 + 5)` would hand `lineOf` the middle of the URL - the same
    // negative-index trap `previousOnLine` above has a comment for.
    //
    // `decodeURIComponent` also throws `URIError` on a malformed escape, and
    // inside `.some()` that failed the whole source on one odd URL in the
    // channel history. A URL we cannot read cannot vouch for a
    // line, which leaves `foundOwn` false - the branch that under-announces
    // rather than the one that loses items.
    const lineOfUrl = (url: string): string | undefined => {
        const at = url.lastIndexOf('/tag/');
        if (at < 0) return undefined;
        try {
            return lineOf(decodeURIComponent(url.slice(at + '/tag/'.length)));
        } catch {
            console.warn(`Could not read a tag from an announced URL: ${url}`);
            return undefined;
        }
    };

    return [...lines.entries()]
        .flatMap(([line, group]) =>
            pending<Release>(group, {
                ...seen,
                foundOwn: [...seen.urls].some(
                    (url) => url.startsWith(ours) && lineOfUrl(url) === line.toLowerCase(),
                ),
            }),
        )
        .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
}

/**
 * One source's pass. Exported for tests: the disposition handling below is the
 * reason `Disposition` exists, and replacing either `throw` with a `continue`
 * used to leave the whole suite green.
 */
export async function announceReleases(source: Source, deadline: number) {
    if (!source.channelId) {
        console.log(`${source.name}: no channel configured, skipping`);
        return;
    }

    // Before the reads, not only between candidates. Checked only inside the
    // loop, a source whose turn began after the budget was spent still paid for
    // a full channel read and up to RELEASE_PAGES of GitHub releases to discover
    // it had no time.
    if (Date.now() > deadline) {
        console.warn(`${source.name}: run budget already spent, deferred to the next run.`);
        return;
    }

    // Scoped to this source: two sources can share a channel, and "has anything
    // been posted here" is the wrong question for deciding whether this one is
    // new to it.
    // Lowercased on both sides: GitHub accepts any casing in an API path but
    // returns the canonical spelling in html_url, so a SOURCES entry written as
    // `copilotkit/openbot` would never match its own announcements and the
    // source would be treated as new to the channel on every run.
    const ours = `https://github.com/${source.repo.toLowerCase()}/releases/`;
    // The same window both times, deliberately. Reading less history than the
    // release listing covers means a release we already announced can fall out
    // of view while still being a candidate, and it gets announced again.
    const window = lookback();
    const seen = await announced(
        source.channelId,
        (url) => url.toLowerCase().startsWith(ours),
        window,
    );

    const releases = (await listReleases(source.repo, window)).filter((r) => source.include(r.tag));

    const backlog = planBacklog(releases, seen, ours);

    if (backlog.length > MAX_CONSIDERED) {
        // The comment on MAX_CONSIDERED promises this line. Reaching the cap
        // means the tail is invisible this run, and silence there is how a
        // runaway guard turns into a quiet truncation.
        console.warn(
            `${source.name}: ${backlog.length} pending, examining ${MAX_CONSIDERED}. ` +
                'The rest is invisible this run.',
        );
    }

    let posted = 0;

    for (const [index, release] of backlog.slice(0, MAX_CONSIDERED).entries()) {
        if (posted >= MAX_PER_RUN) {
            // Logged, like the other two early exits. This is the condition that
            // predicts data loss - a backlog draining slower than it grows ages
            // out of the window - and it was the only one that was invisible.
            //
            // Counted from the loop position, not as `backlog.length - posted`,
            // which counted every release already examined and skipped as still
            // pending. Skips still ahead of the cursor are counted here and some
            // of them will never post, so this remains an upper bound - but it
            // no longer grows with the skips already passed, which is the part
            // that made it useless on a source with a skippable head.
            // Always at least 1: the current release is itself deferred.
            console.warn(
                `${source.name}: posted ${posted}, the per-run cap; ` +
                    `${backlog.length - index} still pending and deferred to the next run.`,
            );
            break;
        }

        if (Date.now() > deadline) {
            console.warn(
                `${source.name}: run budget spent after ${posted} posts; ` +
                    'the rest is deferred to the next run.',
            );
            break;
        }

        // The previous release on this tag line. Taking `releases[i - 1]` picked
        // whatever shipped most recently, and once a repo publishes several
        // lines that is usually a different product: v1.72.0 was compared
        // against channels/v0.10.0 and summarized from 3 commits instead of 46.
        //
        // `releases` stops at the lookback window, so the first release of a
        // line in that window has no baseline in it. That is most releases on a
        // line that ships less than monthly, and they were summarized from the
        // notes alone. Those fall back to a lookup with no time limit.
        const line = lineOf(release.tag);
        let previous = previousOnLine(releases, release);
        if (!previous) {
            // Degrades like contextFor does when its compare fails: a release with
            // no baseline is announced without commit context, which is worse
            // but not wrong. Throwing here failed the whole source for the run
            // over a lookup that only ever improves the summary.
            try {
                previous = await previousRelease(
                    release,
                    (tag) => lineOf(tag) === line && source.include(tag),
                );
            } catch (error) {
                console.warn(`${release.tag}: could not look up the previous release: ${error}`);
            }
        }
        const context = await contextFor(release, previous);
        const summary = await summarize(context);

        if (summary.kind === 'failed' && summary.disposition === 'abort') {
            // Not a per-source failure. The bot is misconfigured, so every
            // remaining source would repeat a full channel read, release
            // listing and OpenAI call only to fail the same way. Rethrown past
            // main()'s per-source handler so the run stops here.
            throw new Misconfigured(`${release.tag}: ${summary.reason}`);
        }

        if (summary.kind === 'failed' && summary.disposition === 'retry') {
            // Stop this source here, holding its position. Announcing a newer
            // release would move the watermark past this one and it would never
            // be retried, even though asking again would have worked.
            throw new Error(`${release.tag}: ${summary.reason}`);
        }

        if (summary.kind === 'skip') {
            console.log(`${release.tag}: nothing user-facing, skipped`);
            continue;
        }

        // A failure that is permanent *for this release* still gets announced,
        // with the link instead of a summary. Raw notes are never posted, but
        // silence is not the answer either: a release that can never be
        // summarized would otherwise block every release behind it for as long
        // as it stays in the window.
        const body =
            summary.kind === 'text' ? summary.text : 'Summary unavailable. See the release notes.';

        if (summary.kind === 'failed') {
            console.error(`${release.tag}: ${summary.reason}; announcing with the link only`);
        }

        const announcement = {
            channelId: source.channelId,
            title: source.title(release),
            body,
            url: release.url,
            pingRoleId: source.pingRoleId,
        };

        if (DRY_RUN) {
            // The composed message, not the raw body: truncation, the title and
            // the trailing URL are exactly what a dry run exists to show, and
            // printing `body` hid all three.
            console.log(`\n--- ${source.name} ${release.tag} ---\n${compose(announcement)}`);
            posted++;
            continue;
        }

        await announce(announcement);
        posted++;
        console.log(`${source.name} ${release.tag}: posted`);
    }
}

/**
 * Videos post as a line of text and a bare link. Discord unfurls the link into a
 * player, which is a better preview than anything we could assemble, so the
 * message stays out of its way.
 */
export async function announceVideos(deadline: number) {
    const channelId = process.env.YOUTUBE_CHANNEL_DISCORD_ID;
    const youtubeChannel = process.env.YOUTUBE_CHANNEL_ID;

    if (!channelId || !youtubeChannel) {
        console.log('youtube: no channel configured, skipping');
        return;
    }

    // Inside the budget like the release sources. The constant's doc claims it
    // bounds the whole run, and with this source outside it that was not true.
    if (Date.now() > deadline) {
        console.warn('youtube: run budget already spent, deferred to the next run.');
        return;
    }

    // Scoped like the release sources. Unscoped, a channel that also carries
    // release announcements answered "yes, posted here before" for the video
    // source on its very first run, which skips pending()'s announce-only-the-
    // newest branch and drains the whole lookback window two videos at a time.
    const window = lookback();
    const seen = await announced(
        channelId,
        (url) => url.toLowerCase().startsWith('https://www.youtube.com/watch'),
        window,
    );
    const videos = await listVideos(youtubeChannel, window);
    const pingRoleId = process.env.YOUTUBE_PING_ROLE_ID;

    const backlog = pending<Video>(videos, seen);

    // Warned like the release sources. Truncating the backlog silently made
    // this the one source where a backlog draining slower than it grows aged
    // out of the window with nothing in the log to predict it.
    if (backlog.length > MAX_PER_RUN) {
        console.warn(
            `youtube: posting ${MAX_PER_RUN}, the per-run cap; ` +
                `${backlog.length - MAX_PER_RUN} still pending and deferred to the next run.`,
        );
    }

    for (const video of backlog.slice(0, MAX_PER_RUN)) {
        // Rechecked per post, like the release loop. Checked only on the way in,
        // a source that started inside the budget could still run past it.
        if (Date.now() > deadline) {
            console.warn('youtube: run budget spent; the rest is deferred to the next run.');
            break;
        }

        // One string, used by both paths. Spelling it twice meant the dry run
        // could preview something other than what would be posted.
        const text = `New video on the YouTube channel\n${video.url}`;

        if (DRY_RUN) {
            console.log(`\n--- youtube ---\n${withPing(text, pingRoleId)}`);
            continue;
        }

        await postText(channelId, text, pingRoleId);
        console.log(`youtube ${video.id}: posted`);
    }
}

/**
 * Each source runs independently, so a broken channel or a rate-limited API
 * cannot take the others down with it. A run that lost any source exits
 * non-zero, because a cron job reporting success while announcing nothing is the
 * one failure nobody notices.
 */
export async function main() {
    const failures: string[] = [];

    const run = async (name: string, work: () => Promise<void>) => {
        try {
            await work();
        } catch (error) {
            // A misconfiguration is not this source's problem, so isolating it
            // buys nothing and costs a full pass per remaining source.
            const fatal =
                error instanceof Misconfigured ||
                (error instanceof Error && MISCONFIGURED.test(error.message));

            if (!fatal) {
                failures.push(name);
                console.error(`${name} failed:`, error);
                return;
            }

            // Logged before the rethrow, for both fatal shapes: the summary line
            // at the end of main() never runs, so anything already broken would
            // otherwise vanish from the one line a cron log tail shows.
            if (failures.length) {
                console.error(`Already failed this run: ${failures.join(', ')}.`);
            }

            // Logged before the branch: the Misconfigured path used to return
            // here without naming the source, and the top-level handler prints
            // only the release tag - so with three sources nothing said which
            // one was running when the run stopped.
            console.error(`${name} failed:`, error);
            if (error instanceof Misconfigured) throw error;

            // `cause` kept: the rethrow is a reclassification, not a new fault,
            // and the original stack is the only thing naming the call site.
            throw new Misconfigured((error as Error).message, { cause: error });
        }
    };

    // Nothing configured at all is not a quiet week, it is a broken deployment.
    // A single unconfigured source is a supported state - that is how sources
    // are rolled out one at a time - but every source unconfigured means the
    // environment never reached the process, and the run would otherwise log
    // four cheerful "skipping" lines and exit 0. That is the cron reporting
    // success while announcing nothing, which is what main() exists to prevent.
    // Found by running `pnpm start` locally, where the script was not loading
    // .env at all.
    const configured =
        SOURCES.some((source) => source.channelId) ||
        Boolean(process.env.YOUTUBE_CHANNEL_DISCORD_ID && process.env.YOUTUBE_CHANNEL_ID);

    if (!configured) {
        throw new Error(
            'No source has a channel configured. Set at least one of AGUI_CHANNEL_ID, ' +
                'CPK_CHANNEL_ID, OPENBOT_CHANNEL_ID, or both YOUTUBE_CHANNEL_DISCORD_ID ' +
                'and YOUTUBE_CHANNEL_ID.',
        );
    }

    // Checked up front, like DISCORD_BOT_TOKEN and GITHUB_TOKEN, which their
    // clients throw on at the first call of every run. OPENAI_API_KEY was the
    // one credential validated lazily: summarize() is only reached when a
    // release is actually pending, so on a quiet week a deployment missing it
    // ran to completion and exited 0 with nothing in the log. That is the same
    // cron-reports-success failure the check above exists to prevent.
    //
    // Conditioned on a release source, because videos need no OpenAI and a
    // YouTube-only deployment is a legitimate configuration.
    //
    // Computed here and thrown only after the video run below, and that order
    // is the whole point: throwing before the video run silenced YouTube for a
    // missing key, which is exactly the failure the video-first ordering below
    // exists to prevent. It fixed the revoked-key path and reintroduced the same
    // outcome for the absent-key path, earlier and more completely, because
    // announceVideos was never entered at all.
    const needsModel = SOURCES.some((source) => source.channelId) && !process.env.OPENAI_API_KEY;

    // One deadline for the whole run, not one per source.
    const deadline = Date.now() + RUN_BUDGET_MS;

    // Videos first. They need neither OpenAI nor GitHub, and Misconfigured
    // rethrows past the per-source handler - so a revoked OpenAI key used to
    // silence video announcements too, for a reason that had nothing to do with
    // them.
    await run('youtube', () => announceVideos(deadline));

    if (needsModel) {
        // Names any video failure from the run above too, rather than letting
        // this error replace it.
        throw new Error(
            'OPENAI_API_KEY is not set, and a release source has a channel configured. ' +
                'Release notes are never posted unsummarized, so no release was announced. ' +
                'Video announcements do not need it and were not affected.' +
                (failures.length ? ` Sources failed: ${failures.join(', ')}.` : ''),
        );
    }

    for (const source of SOURCES) {
        await run(source.name, () => announceReleases(source, deadline));
    }

    if (failures.length) {
        throw new Error(`Sources failed: ${failures.join(', ')}. The others completed.`);
    }
}

// Only when run as the entry point. `pending()` used to live here, and importing
// it from a test started a real announcement run.
// Real paths on both sides. Node resolves the main module's symlinks but leaves
// process.argv[1] as written, so through a node_modules/.bin shim, a symlinked
// deploy directory, or macOS's /tmp -> /private/tmp, the two never matched:
// main() did not run, nothing was announced, and the process exited 0 - the
// cron-reports-success failure this file's own doc calls the one nobody notices.
const entry = (() => {
    // realpathSync throws ENOENT on a path that does not resolve, and this runs
    // during module evaluation, before any handler exists. An argv[1] we cannot
    // resolve is one we cannot compare, which is the same answer as absent.
    try {
        return process.argv[1] ? realpathSync(process.argv[1]) : undefined;
    } catch (error) {
        // Warned rather than swallowed. An *absent* argv[1] is a library import
        // and legitimately silent; an *unresolvable* one is an anomaly on a path
        // the operator asked to execute, and returning undefined for it means
        // main() never runs and the process exits 0 with no output at all.
        console.warn(
            `Could not resolve ${process.argv[1]}: ${error}. Not running as the entry point.`,
        );
        return undefined;
    }
})();
if (entry && import.meta.url === pathToFileURL(entry).href) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

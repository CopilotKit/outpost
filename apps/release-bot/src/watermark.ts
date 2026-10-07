/**
 * Deciding what to announce, given what a channel already shows.
 *
 * This lives apart from the entry point so it can be imported without starting
 * an announcement run: `index.ts` used to call `main()` unconditionally when it
 * loaded, and a test that imported it for this function performed a real pass.
 */

import type { Announced } from './discord.js';

export type Item = { url: string; publishedAt: string };

/**
 * Pending items, oldest first.
 *
 * The rule is "newer than the last thing announced", not "everything absent from
 * the channel". Those sound alike and are not: the second walks backwards
 * through history and announces items that predate the bot entirely.
 *
 * The most recent announcement is a watermark, and items go out oldest-first so
 * it advances one step at a time. Taking the newest items instead moved the
 * watermark straight to the top and everything between was dropped permanently.
 *
 * The caller decides how many of these to post. This returns the whole backlog
 * on purpose: capping here meant a skipped item consumed a slot forever, and two
 * skippable items in a row stalled a source until they aged out of the window.
 */
export function pending<T extends Item>(items: T[], seen: Announced): T[] {
    const dated = items.filter((item) => {
        if (Number.isNaN(Date.parse(item.publishedAt))) {
            // One unparseable timestamp would otherwise poison the watermark
            // through Math.max and take the source silent with no explanation.
            console.warn(`Ignoring ${item.url}: unparseable timestamp ${item.publishedAt}`);
            return false;
        }
        return true;
    });

    const announced = dated.filter((item) => seen.urls.has(item.url.toLowerCase()));

    if (announced.length) {
        const watermark = Math.max(...announced.map((item) => Date.parse(item.publishedAt)));
        return dated.filter((item) => {
            const at = Date.parse(item.publishedAt);
            // Ties count as pending unless already seen: AG-UI publishes several
            // releases within the same second, and a strict comparison dropped
            // whichever one was not announced first.
            return at > watermark || (at === watermark && !seen.urls.has(item.url.toLowerCase()));
        });
    }

    // Nothing of ours matched. Either the bot has never posted here, or whatever
    // it announced is older than the history we read.
    if (!seen.foundOwn) return dated.slice(-1);

    // It has posted, just not about anything in range. Anything published after
    // the oldest message we read would have been visible if it had been
    // announced, so those are genuinely pending; older items are assumed done.
    const floor = seen.searchedFrom ? Date.parse(seen.searchedFrom) : NaN;
    if (Number.isNaN(floor)) return dated.slice(-1);

    // Inclusive of the floor itself, for the same reason the watermark branch
    // above is: AG-UI publishes several releases within one second, and
    // `searchedFrom` is a real message timestamp. A release published in the
    // same second as that message was not announced by it.
    return dated.filter((item) => {
        const at = Date.parse(item.publishedAt);
        return at > floor || (at === floor && !seen.urls.has(item.url.toLowerCase()));
    });
}

/**
 * Link-spam gate for inbound GitHub issues.
 *
 * Why this exists. On 2026-09-10/11 two throwaway accounts
 * (`sarahnicholas1327-lgtm`, `kaylaford203-beep`) filed 23 SEO backlink issues on
 * CopilotKit/CopilotKit — ~3.3 KB of marketing prose each, every one carrying a
 * dozen-odd links to `1rank.app` / `zagfro.com`. Outpost relayed each body
 * VERBATIM into `search-docs` + `search-code` on mcp.copilotkit.ai within ~4
 * seconds of creation, then answered the issue publicly. That is amplification:
 * the spammer wrote once and got a machine-generated reply and 46 rows of
 * retrieval traffic for free, and the blobs went on to pollute Pathfinder's Top
 * Queries panel, the weekly Notion report, and the monthly gap-analysis LLM
 * prompt.
 *
 * The gate is deliberately narrow. Its job is to drop a body that is a link
 * advertisement, NOT to score quality — a bad bug report still deserves an
 * answer, and a false positive here is silent (no ticket, no reply, no trace on
 * the issue). All four conditions must hold.
 *
 * Measured on the FULL issue history of CopilotKit/CopilotKit (1,264 non-spam
 * issues by 1,264-issue authorship, plus all 23 known spam issues):
 *
 *   | rule                                                        | spam  | legit    |
 *   |-------------------------------------------------------------|-------|----------|
 *   | body >= 3000 chars AND >= 6 urls                             | 23/23 | 15/1264  |
 *   |   + untrusted author                                         | 23/23 | 14/1264  |
 *   | THIS RULE (untrusted, long, no code fence, one host >= 5x)   | 23/23 |  0/1264  |
 *
 * A length-and-url rule alone is NOT sufficient: it eats real bug reports
 * (#2667 is 40 KB with 16 urls, #3510 is 13 KB with 26). The two terms that buy
 * the separation are the ones that describe an advertisement rather than a
 * report: it contains no fenced code block, and its links point over and over at
 * the SAME third-party host. A stack trace or a repro has code in it; a backlink
 * campaign does not, because the links are the payload.
 *
 * Honest scope: this is fitted on one campaign and one repo's history. It is a
 * discriminator, not a general spam classifier, and the next campaign may look
 * different. The truncation and `X-Pathfinder-Source` changes in
 * `packages/outpost/ai/src/pathfinder.ts` are the content-independent half of
 * the defence and do not depend on this rule firing.
 */

/**
 * `author_association` values that mean the author has a real relationship with
 * the repo. A spam account is `NONE` by construction — it has never had a PR or
 * a commit merged. Requiring untrusted authorship means a maintainer or a prior
 * contributor can never be silenced by this gate, whatever they write.
 *
 * `CONTRIBUTOR` is included as trusted: it means GitHub has already seen a
 * merged commit from this account in this repo.
 */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set([
    'OWNER',
    'MEMBER',
    'COLLABORATOR',
    'CONTRIBUTOR',
]);

/**
 * Hosts that do not count towards "links at one third-party host". Our own docs
 * and GitHub itself are what a legitimate issue links to repeatedly — a reporter
 * citing eight `github.com/...` permalinks is doing exactly the right thing.
 * Matched on the host or any subdomain of it.
 */
const FIRST_PARTY_HOSTS: readonly string[] = [
    'github.com',
    'githubusercontent.com',
    'copilotkit.ai',
    'ag-ui.com',
    'localhost',
];

/** Minimum body length before the gate will consider anything. */
const MIN_BODY_CHARS = 1500;

/** Minimum links to ONE third-party host before the body reads as an ad. */
const MIN_LINKS_TO_ONE_HOST = 5;

function isFirstParty(host: string): boolean {
    return FIRST_PARTY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * The largest number of links in `body` pointing at a single third-party host.
 *
 * Counts raw URL occurrences rather than markdown links: the spam bodies mix
 * `[anchor](url)` with bare urls and with the same domain written as plain text
 * inside a sentence, and only the total is stable across those spellings.
 */
export function maxLinksToOneThirdPartyHost(body: string): number {
    const counts = new Map<string, number>();
    for (const match of body.matchAll(/https?:\/\/([^/\s)>\]"'`]+)/gi)) {
        const host = match[1]
            .toLowerCase()
            .replace(/^www\./, '')
            .replace(/:\d+$/, '');
        if (isFirstParty(host)) continue;
        counts.set(host, (counts.get(host) ?? 0) + 1);
    }
    let max = 0;
    for (const n of counts.values()) max = Math.max(max, n);
    return max;
}

/** Whether `body` contains at least one fenced code block. */
export function hasFencedCode(body: string): boolean {
    // Two fence markers, i.e. an opened AND closed block. A single stray "```"
    // is not evidence of a repro.
    return (body.match(/```/g)?.length ?? 0) >= 2;
}

export interface SpamCandidate {
    /** The issue body as filed. */
    body: string | null | undefined;
    /** The webhook payload's `issue.author_association`. */
    authorAssociation: string | null | undefined;
}

/**
 * Whether this issue is a link advertisement that must NOT be relayed.
 *
 * Returns false for anything it is not sure about: an empty body, a trusted
 * author, a short body, a body with a repro in it, or a body whose links are
 * spread across hosts.
 */
export function isLikelySpamIssue({ body, authorAssociation }: SpamCandidate): boolean {
    if (!body) return false;
    if (TRUSTED_ASSOCIATIONS.has((authorAssociation ?? '').toUpperCase())) return false;
    if (body.length < MIN_BODY_CHARS) return false;
    if (hasFencedCode(body)) return false;
    return maxLinksToOneThirdPartyHost(body) >= MIN_LINKS_TO_ONE_HOST;
}

# Discord → Channels SDK Rewire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `apps/discord-bot`'s hand-rolled discord.js transport, event handling, interactions, and message rendering with `@copilotkit/channels` + `@copilotkit/channels-discord`, while Outpost's ticket/queue/worker/AI pipeline stays intact underneath.

**Architecture:** The SDK is used as **Discord transport + JSX rendering only** — never as the agent runtime (`thread.runAgent()` is never called). Inbound: SDK gateway turns are translated to Outpost's `InboundMessage` and passed to the existing `InboundHandler`. Outbound: the worker keeps posting via the stateless REST adapter, but message construction moves to the SDK's Discord renderer. Everything is behind `DISCORD_USE_CHANNELS_SDK` so the legacy path stays until parity is verified.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Turborepo + pnpm workspaces, `discord.js@^14`, `@copilotkit/channels` / `@copilotkit/channels-discord`, Vitest, Prisma, Postgres job queue.

## Global Constraints

- **Package manager:** pnpm workspaces. Add deps with `pnpm --filter <pkg> add`. Never edit lockfile by hand.
- **ESM import specifiers:** all relative imports use the `.js` extension (e.g. `./config.js`) even for `.ts` sources. Match the existing style.
- **No behavior change when the flag is off.** `DISCORD_USE_CHANNELS_SDK` defaults to `false`; the legacy path (`Client` + `events/*` + `interactions/*`) must remain byte-for-byte reachable and unchanged in behavior until a later delete-old PR.
- **discord.js single version.** `apps/discord-bot` and `@copilotkit/channels-discord` must resolve to one `discord.js@^14` instance (verify with `pnpm --filter @copilotkit/outpost-discord-bot why discord.js`). Two `Client` classes will break `instanceof` checks.
- **Keep the ticket engine untouched.** Do not modify `packages/outpost/shared/src/platforms/inbound.ts` (`InboundHandler`), `packages/outpost/queue`, `apps/worker`'s job loop, or `packages/outpost/ai`.
- **Preserve shadow mode.** When `isShadowMode()` is true, the SDK path must not post anything visible to Discord (no `thread.post`), matching `apps/discord-bot/src/lib/shadow-mode.ts`.
- **GitHub is out of scope.** This plan touches Discord only.

---

### Task 1: Add dependencies and resolve the ingress model (gating spike)

This task unblocks everything else. The SDK's Discord listener pre-filters ingress to **@-mentions**, but Outpost is **forum/channel-monitored** (a new forum post = new ticket; every non-bot reply in a tracked thread = a ticket reply — no mention). We must confirm how to make the SDK deliver those turns before building the inbound bridge.

**Files:**
- Modify: `apps/discord-bot/package.json` (add deps)
- Modify: `apps/discord-bot/tsconfig.json` (JSX runtime, only if the bot renders JSX acks)
- Create: `docs/superpowers/plans/2026-07-16-discord-ingress-findings.md` (the decision record)
- Create: `apps/discord-bot/src/channels/__tests__/ingress.spike.test.ts`

**Interfaces:**
- Produces (recorded in the findings doc, consumed by Tasks 2–6): the exact SDK API surface — the `discord(opts)` option shape, whether `createChannel().onMessage`/`onThreadStarted` deliver monitored-channel + forum-thread-start turns under some `ListenerConfig`, OR the lower-level `attachDiscordListener(client, config, sink)` signature + `ClientLike` if we must attach our own listener; the `IncomingTurn` / `ReplyTarget` field names; and the `renderDiscordMessage(ir)` import path + return shape (`{ components, flags }`).

- [ ] **Step 1: Add the SDK packages to the Discord bot**

Run:
```bash
pnpm --filter @copilotkit/outpost-discord-bot add @copilotkit/channels @copilotkit/channels-discord
```
(Confirm the workspace package name first with `node -p "require('./apps/discord-bot/package.json').name"`; use that exact name in `--filter`.)

- [ ] **Step 2: Verify a single discord.js version**

Run: `pnpm --filter @copilotkit/outpost-discord-bot why discord.js`
Expected: a single `discord.js@14.x` resolution shared by the app and `@copilotkit/channels-discord`. If two versions appear, add a `pnpm.overrides` entry pinning `discord.js` to the app's `^14` and re-install.

- [ ] **Step 3: Read the SDK listener + adapter source and record the ingress mechanism**

Read these files from the CopilotKit repo (GitHub `CopilotKit/CopilotKit`, `main`):
```
packages/channels-discord/src/discord-listener.ts   # ListenerConfig, mention filter, forum/thread handling
packages/channels-discord/src/adapter.ts            # discord() options, intents, start(sink)
packages/channels-discord/src/types.ts              # IncomingTurn, ReplyTarget, conversationKeyOf
packages/channels-core/src/create-channel.ts        # onMessage/onThreadStarted routing
packages/channels-discord/src/render/components-v2.ts # renderDiscordMessage/renderComponents signatures
```
Fetch each with:
```bash
gh api "repos/CopilotKit/CopilotKit/contents/packages/<path>" --jq '.content' | base64 -d
```
Write findings to `docs/superpowers/plans/2026-07-16-discord-ingress-findings.md`, answering: (a) Does `ListenerConfig` (or `discord()` opts) allow non-mention, channel-scoped ingress and a forum-thread-start signal? (b) If yes, which handler/flag delivers it — record the exact option names. (c) If no, record the `attachDiscordListener` / `ClientLike` signature to attach our own listener. (d) Record `IncomingTurn`/`ReplyTarget` field names and the `renderDiscordMessage` import + return shape.

- [ ] **Step 4: Write the spike test proving forum ingress reaches a handler**

Using the resolved mechanism, write a test that boots a channel with the Discord adapter against a fake/`ClientLike` client (or the SDK's testing double if one exists), emits a **forum thread create** and a **reply in that thread with no mention**, and asserts both reach a registered handler.

```ts
// apps/discord-bot/src/channels/__tests__/ingress.spike.test.ts
import { describe, it, expect, vi } from 'vitest';
// import path + config decided in Step 3 (Branch A: createChannel config; Branch B: attachDiscordListener + ClientLike)

describe('ingress spike: forum monitoring without mention', () => {
  it('delivers a forum thread-start turn to a handler', async () => {
    const seen: Array<{ kind: string; threadId: string }> = [];
    // ...wire the resolved ingress mechanism, register a handler that pushes to `seen`,
    //    emit a fake forum ThreadCreate for a monitored parent channel...
    expect(seen).toContainEqual(expect.objectContaining({ kind: 'thread-start' }));
  });

  it('delivers a non-mention reply in a tracked thread to a handler', async () => {
    const seen: string[] = [];
    // ...emit a fake messageCreate (author.bot=false, no bot mention) inside the thread...
    expect(seen.length).toBe(1);
  });
});
```

- [ ] **Step 5: Run the spike test**

Run: `pnpm --filter @copilotkit/outpost-discord-bot test -- ingress.spike`
Expected: PASS (both cases). If Branch A is impossible and Branch B (own listener over `ClientLike`) is required, the test passes against Branch B. If neither works, STOP and escalate — the bridge approach needs revisiting before further tasks.

- [ ] **Step 6: Commit**

```bash
git add apps/discord-bot/package.json apps/discord-bot/tsconfig.json pnpm-lock.yaml docs/superpowers/plans/2026-07-16-discord-ingress-findings.md apps/discord-bot/src/channels/__tests__/ingress.spike.test.ts
git commit -m "feat(discord-bot): add channels SDK deps + resolve forum ingress (spike)"
```

---

### Task 2: Add the flag and dual-boot skeleton

**Files:**
- Modify: `apps/discord-bot/src/config.ts` (add `useChannelsSdk`)
- Modify: `apps/discord-bot/src/index.ts` (branch on the flag)
- Create: `apps/discord-bot/src/channels/bot.ts` (SDK boot, no handlers yet)
- Test: `apps/discord-bot/src/channels/__tests__/config.test.ts`

**Interfaces:**
- Consumes: the resolved `discord(opts)` shape from Task 1.
- Produces: `export function createChannelsBot(): { start(): Promise<void>; stop(): Promise<void> }` in `channels/bot.ts`; `config.useChannelsSdk: boolean`.

- [ ] **Step 1: Write the failing test for the flag**

```ts
// apps/discord-bot/src/channels/__tests__/config.test.ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';

describe('useChannelsSdk flag', () => {
  const prev = process.env.DISCORD_USE_CHANNELS_SDK;
  afterEach(() => { process.env.DISCORD_USE_CHANNELS_SDK = prev; });

  it('defaults to false', async () => {
    delete process.env.DISCORD_USE_CHANNELS_SDK;
    const { readUseChannelsSdk } = await import('../../config.js');
    expect(readUseChannelsSdk()).toBe(false);
  });

  it('is true only for "true"', async () => {
    process.env.DISCORD_USE_CHANNELS_SDK = 'true';
    const { readUseChannelsSdk } = await import('../../config.js');
    expect(readUseChannelsSdk()).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`readUseChannelsSdk` not exported).
Run: `pnpm --filter @copilotkit/outpost-discord-bot test -- config`

- [ ] **Step 3: Add the flag to config.ts**

Add to `apps/discord-bot/src/config.ts`:
```ts
export function readUseChannelsSdk(): boolean {
    return (process.env.DISCORD_USE_CHANNELS_SDK ?? 'false').toLowerCase() === 'true';
}
```
And add `useChannelsSdk: readUseChannelsSdk(),` to the `config` object.

- [ ] **Step 4: Create the SDK boot module (handlers added in later tasks)**

```ts
// apps/discord-bot/src/channels/bot.ts
import { createChannel } from '@copilotkit/channels';
import { discord } from '@copilotkit/channels-discord';
import { config } from '../config.js';

/** Boots the Channels-SDK-backed Discord bot. No agent is registered —
 *  the SDK is transport + rendering only; inbound is bridged to InboundHandler. */
export function createChannelsBot() {
    const bot = createChannel({
        adapters: [
            discord({
                botToken: config.discordToken,
                appId: config.clientId,
                guildId: config.guildId,
                // ingress config from Task 1 findings goes here
            }),
        ],
    });
    // Task 3 registers inbound handlers; Task 4 commands; Task 5 interactions.
    return {
        async start() { await bot.start(); },
        async stop() { await bot.stop(); },
        _bot: bot,
    };
}
```

- [ ] **Step 5: Branch the entrypoint on the flag**

In `apps/discord-bot/src/index.ts`, wrap the existing legacy boot in `if (!config.useChannelsSdk) { ...legacy... } else { const bot = createChannelsBot(); bot.start().catch(...); }`, and route SIGINT/SIGTERM to `bot.stop()` on the SDK path. Keep the legacy branch unchanged.

- [ ] **Step 6: Run the test — expect PASS.** Run: `pnpm --filter @copilotkit/outpost-discord-bot test -- config`

- [ ] **Step 7: Commit**
```bash
git add apps/discord-bot/src/config.ts apps/discord-bot/src/index.ts apps/discord-bot/src/channels/bot.ts apps/discord-bot/src/channels/__tests__/config.test.ts
git commit -m "feat(discord-bot): DISCORD_USE_CHANNELS_SDK flag + SDK boot skeleton"
```

---

### Task 3: Inbound bridge — turns → InboundHandler

Translate SDK turns into `InboundMessage` and run the existing `InboundHandler`, preserving monitored-channel filtering and shadow mode. Reuses the legacy `createJobFn` and `isThreadStart` semantics.

**Files:**
- Create: `apps/discord-bot/src/channels/inbound.ts`
- Modify: `apps/discord-bot/src/channels/bot.ts` (register handlers)
- Test: `apps/discord-bot/src/channels/__tests__/inbound.test.ts`

**Interfaces:**
- Consumes: `IncomingTurn`/`ReplyTarget` fields (Task 1); `InboundMessage` (`packages/outpost/shared/src/platforms/types.ts` — fields: `platformUserId`, `platformUsername`, `content`, `threadId`, `channelId`, `sourceUrl`, `source`, `isThreadStart`, `rawEvent`); `InboundHandler` and `TicketSource.DISCORD`.
- Produces: `export function toInboundMessage(turn, opts: { isThreadStart: boolean }): InboundMessage`; `export function registerInbound(bot, deps)`.

- [ ] **Step 1: Write the failing mapping test**

```ts
// apps/discord-bot/src/channels/__tests__/inbound.test.ts
import { describe, it, expect } from 'vitest';
import { toInboundMessage } from '../inbound.js';
import { TicketSource } from '@copilotkit/outpost/shared';

it('maps a forum thread-start turn to an isThreadStart InboundMessage', () => {
  const turn = { // shape confirmed in Task 1
    user: { id: 'u1', name: 'alice' },
    text: 'help pls',
    target: { threadId: 't1', channelId: 'forum1', url: 'https://discord.com/channels/g/t1' },
  };
  const msg = toInboundMessage(turn, { isThreadStart: true });
  expect(msg).toMatchObject({
    platformUserId: 'u1', platformUsername: 'alice', content: 'help pls',
    threadId: 't1', channelId: 'forum1', source: TicketSource.DISCORD, isThreadStart: true,
  });
});

it('maps a reply turn to isThreadStart:false', () => {
  const turn = { user: { id: 'u2', name: 'bob' }, text: 'still broken', target: { threadId: 't1', channelId: 'forum1' } };
  expect(toInboundMessage(turn, { isThreadStart: false }).isThreadStart).toBe(false);
});
```
(Replace the `turn` field names with the exact ones from Task 1's findings.)

- [ ] **Step 2: Run it — expect FAIL** (`toInboundMessage` not defined).

- [ ] **Step 3: Implement the mapping + handler registration**

```ts
// apps/discord-bot/src/channels/inbound.ts
import { prisma } from '@copilotkit/outpost/db';
import { createJob } from '@copilotkit/outpost/queue';
import { InboundHandler } from '@copilotkit/outpost/shared/platforms';
import { TicketSource } from '@copilotkit/outpost/shared';
import type { CreateJobFn, InboundMessage } from '@copilotkit/outpost/shared';
import { config } from '../config.js';
import { isShadowMode } from '../lib/shadow-mode.js';

const createJobFn: CreateJobFn = async (type, payload) =>
    createJob(type as Parameters<typeof createJob>[0], payload as Parameters<typeof createJob>[1]);

// Field accessors reflect the Task 1 IncomingTurn/ReplyTarget shape.
export function toInboundMessage(turn: any, opts: { isThreadStart: boolean }): InboundMessage {
    return {
        platformUserId: turn.user?.id ?? '',
        platformUsername: turn.user?.name ?? turn.user?.handle ?? 'Unknown',
        content: turn.text ?? '',
        threadId: turn.target?.threadId,
        channelId: turn.target?.channelId,
        sourceUrl: turn.target?.url,
        source: TicketSource.DISCORD,
        isThreadStart: opts.isThreadStart,
        rawEvent: turn,
    };
}

function isMonitored(channelId: string | undefined): boolean {
    if (config.monitoredChannelIds.length === 0) return true;
    return !!channelId && config.monitoredChannelIds.includes(channelId);
}

export function registerInbound(bot: { onMessage: Function; onThreadStarted?: Function }): void {
    // Thread-start (new forum post → new ticket). Uses the ingress signal resolved in Task 1
    // (onThreadStarted if the adapter emits it for forum posts; otherwise a first-message flag on the turn).
    const handleStart = async ({ thread, message }: any) => {
        const channelId = thread?.target?.channelId ?? message?.target?.channelId;
        if (!isMonitored(channelId)) return;
        const msg = toInboundMessage(message ?? thread, { isThreadStart: true });
        const result = await new InboundHandler({ prisma, createJob: createJobFn }).handle(msg);
        if (!isShadowMode()) {
            await thread.post(`🎫 Ticket ${result.displayId} created. Our AI assistant is reviewing your question...`);
        }
    };
    const handleReply = async ({ thread, message }: any) => {
        const channelId = message?.target?.channelId;
        if (!isMonitored(channelId)) return;
        const msg = toInboundMessage(message, { isThreadStart: false });
        await new InboundHandler({ prisma, createJob: createJobFn }).handle(msg);
    };
    if (bot.onThreadStarted) bot.onThreadStarted(handleStart);
    bot.onMessage(handleReply);
    // If Task 1 shows forum-starts arrive via onMessage with a first-message flag, branch inside onMessage instead.
}
```
Wire `registerInbound(bot._bot)` into `createChannelsBot()`.

- [ ] **Step 4: Run the mapping test — expect PASS.**

- [ ] **Step 5: Add an integration test that the handler enqueues a job**

Use `@copilotkit/channels/testing` (API confirmed in Task 1) to drive a forum-start turn through a booted channel with `prisma`/`createJob` mocked; assert `InboundHandler` created a ticket and enqueued `AI_RESPONSE`. Mock `@copilotkit/outpost/db` and `@copilotkit/outpost/queue` with `vi.mock`.

- [ ] **Step 6: Run it — expect PASS.**

- [ ] **Step 7: Commit**
```bash
git add apps/discord-bot/src/channels/inbound.ts apps/discord-bot/src/channels/bot.ts apps/discord-bot/src/channels/__tests__/inbound.test.ts
git commit -m "feat(discord-bot): bridge SDK turns to InboundHandler (thread-start + reply)"
```

---

### Task 4: Slash commands via onCommand

Port `escalate`, `assign`, `priority`, `close` to the SDK's `onCommand`. The existing handlers in `commands/*.ts` take a discord.js `ChatInputCommandInteraction`; extract their ticket logic into interaction-agnostic functions so both paths reuse it.

**Files:**
- Create: `apps/discord-bot/src/channels/commands.ts` (SDK command registration)
- Modify: `apps/discord-bot/src/commands/{escalate,assign,priority,close}.ts` (extract pure logic — only if needed; otherwise call a shared core fn)
- Modify: `apps/discord-bot/src/channels/bot.ts` (register commands)
- Test: `apps/discord-bot/src/channels/__tests__/commands.test.ts`

**Interfaces:**
- Consumes: the `onCommand`/`CommandContext` shape (Task 1); existing command ticket logic.
- Produces: `export function registerCommands(bot): void`.

- [ ] **Step 1: Write a failing test** that a registered `escalate` command, given a thread with a known ticket, calls the ticket-escalation core logic (mock the core fn, assert called with the resolved ticket id).

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Extract command core logic** (e.g. `escalateTicket(threadId, actor)`) from `commands/escalate.ts` into a small exported function; have the legacy handler call it (no behavior change). Repeat for the four commands as the tests require.

- [ ] **Step 4: Implement `registerCommands(bot)`** mapping each `onCommand({ name, description, options, handler })` to the extracted core logic, resolving the ticket via `findTicketByThreadId(thread.target.threadId)` and replying with `thread.post(...)`.

- [ ] **Step 5: Run tests — expect PASS.**

- [ ] **Step 6: Commit**
```bash
git add apps/discord-bot/src/channels/commands.ts apps/discord-bot/src/commands apps/discord-bot/src/channels/bot.ts apps/discord-bot/src/channels/__tests__/commands.test.ts
git commit -m "feat(discord-bot): port slash commands to SDK onCommand"
```

---

### Task 5: Button feedback via onInteraction

The two feedback buttons use **fixed** `custom_id`s (`issue_solved`, `need_more_help`) — not content-minted `ck:` ids — so they map directly to the SDK's `onInteraction(id, handler)` escape hatch. No durable `ActionStore` is required (Risk 2 mitigated).

**Files:**
- Create: `apps/discord-bot/src/channels/interactions.ts`
- Modify: `apps/discord-bot/src/interactions/buttons.ts` (extract interaction-agnostic core: `markIssueSolved(threadId, actor)`, `requestMoreHelp(threadId, actor)`)
- Modify: `apps/discord-bot/src/channels/bot.ts` (register)
- Test: `apps/discord-bot/src/channels/__tests__/interactions.test.ts`

**Interfaces:**
- Consumes: `onInteraction<TValue>(id, handler)` + interaction ctx (Task 1); the extracted core fns.
- Produces: `export function registerInteractions(bot): void`; `export async function markIssueSolved(threadId: string, actor: string): Promise<{ displayId: string } | null>`; `export async function requestMoreHelp(threadId: string, actor: string): Promise<{ displayId: string } | null>`.

- [ ] **Step 1: Write failing tests** for `markIssueSolved` (sets ticket `CLOSED`, records `POSITIVE` feedback, writes a SYSTEM message) and `requestMoreHelp` (sets `WAITING_ON_TEAM`, records `NEGATIVE`, enqueues `ESCALATION`, writes a SYSTEM message). Mock `prisma`/`createJob`.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Extract the core logic** from `interactions/buttons.ts` into `markIssueSolved`/`requestMoreHelp` (moving the bodies of `handleIssueSolved`/`handleNeedMoreHelp` minus the discord.js reply). Have the legacy handlers call them + do their `interaction.reply` (no behavior change).

- [ ] **Step 4: Implement `registerInteractions(bot)`**:
```ts
// apps/discord-bot/src/channels/interactions.ts
import { markIssueSolved, requestMoreHelp } from '../interactions/buttons.js';
export function registerInteractions(bot: { onInteraction: Function }): void {
    bot.onInteraction('issue_solved', async ({ thread }: any) => {
        const r = await markIssueSolved(thread.target.threadId, 'user');
        await thread.post(r ? 'Glad we could help! 🎉' : 'No ticket found for this thread.');
    });
    bot.onInteraction('need_more_help', async ({ thread }: any) => {
        const r = await requestMoreHelp(thread.target.threadId, 'user');
        await thread.post(r ? 'A team member has been notified and will follow up shortly.' : 'No ticket found for this thread.');
    });
}
```

- [ ] **Step 5: Run tests — expect PASS.**

- [ ] **Step 6: Commit**
```bash
git add apps/discord-bot/src/channels/interactions.ts apps/discord-bot/src/interactions/buttons.ts apps/discord-bot/src/channels/bot.ts apps/discord-bot/src/channels/__tests__/interactions.test.ts
git commit -m "feat(discord-bot): port feedback buttons to SDK onInteraction"
```

---

### Task 6: Outbound rendering via the SDK renderer

The worker still calls `getAdapter(DISCORD).postResponse(...)`. Replace the adapter's hand-rolled `splitMessage` + manual ActionRow with the SDK's Discord renderer, keeping the stateless REST POST (the worker has no live gateway). Build the render IR from `FormattedResponse` (plain `text` + `buttons`).

**Files:**
- Modify: `packages/outpost/shared/src/platforms/discord.ts` (`postResponse` render path)
- Modify: `packages/outpost/shared/tsconfig.json` **only if** JSX is used to build the IR (prefer the non-JSX element/`renderComponents` API to avoid changing the shared build)
- Test: `packages/outpost/shared/src/platforms/__tests__/discord-render.test.ts`

**Interfaces:**
- Consumes: `renderDiscordMessage(ir)` → `{ components, flags }` and the IR element builders (Task 1); `FormattedResponse` (`text`, `buttons?`, `parts?`).
- Produces: unchanged `DiscordAdapter.postResponse` signature (behavior: renders via SDK, posts via REST).

- [ ] **Step 1: Write a failing render test**

```ts
// packages/outpost/shared/src/platforms/__tests__/discord-render.test.ts
import { describe, it, expect } from 'vitest';
import { buildDiscordBody } from '../discord.js';

it('renders text into a Components V2 body with the IsComponentsV2 flag', () => {
  const body = buildDiscordBody({ text: 'hello' });
  expect(body.flags).toBeDefined();
  expect(Array.isArray(body.components)).toBe(true);
});

it('renders feedback buttons with fixed custom_ids', () => {
  const body = buildDiscordBody({ text: 'answer', buttons: [
    { label: 'Issue Solved', action: 'issue_solved' },
    { label: 'Need more help', action: 'need_more_help' },
  ]});
  const json = JSON.stringify(body);
  expect(json).toContain('issue_solved');
  expect(json).toContain('need_more_help');
});
```

- [ ] **Step 2: Run — expect FAIL** (`buildDiscordBody` not defined).

- [ ] **Step 3: Implement `buildDiscordBody(response)`** in `discord.ts` using the SDK IR builders + `renderDiscordMessage` (exact import from Task 1 findings), mapping `response.buttons` to `Button` nodes carrying the fixed `custom_id`s. Keep the length-degradation to the SDK's `DISCORD_LIMITS` budget (no more hand-rolled `splitMessage` for the response path).

- [ ] **Step 4: Rewrite `postResponse`** to `const body = buildDiscordBody(response); await rest.post(Routes.channelMessages(threadId), { body });` (posting once; the renderer handles chunking/overflow per `DISCORD_LIMITS`). Keep the `sourceId` guard and the return value.

- [ ] **Step 5: Run tests — expect PASS.** Also run the full shared test suite to catch consumers: `pnpm --filter @copilotkit/outpost test`.

- [ ] **Step 6: Commit**
```bash
git add packages/outpost/shared/src/platforms/discord.ts packages/outpost/shared/src/platforms/__tests__/discord-render.test.ts
git commit -m "feat(shared): render Discord responses via channels SDK renderer"
```

---

### Task 7: Parity verification + docs + dashboard

**Files:**
- Modify: `.env.example` (document `DISCORD_USE_CHANNELS_SDK`, `DISCORD_APP_ID` if newly required)
- Modify: `apps/discord-bot/README.md` (SDK path, flag, cutover steps) — create if absent
- Notion: populate the "Rewiring to Channels SDK" dashboard

- [ ] **Step 1: Full build + typecheck + tests**

Run: `pnpm --filter @copilotkit/outpost-discord-bot build && pnpm --filter @copilotkit/outpost-discord-bot test && pnpm --filter @copilotkit/outpost test`
Expected: all green.

- [ ] **Step 2: Manual smoke against a test guild** (flag on)
New forum post → ticket created + ack; non-mention reply → ticket reply; each of the 4 slash commands; both feedback buttons; trigger an `AI_RESPONSE` and confirm the worker posts the rendered reply. Record results in the PR description.

- [ ] **Step 3: Document env + cutover** in `.env.example` and the bot README (flag default, per-env rollout order, rollback = unset flag, and that legacy deletion is a fast-follow PR).

- [ ] **Step 4: Populate the Notion dashboard** with: scope (Discord only, GitHub deferred + why), the ingress decision from Task 1, the risk table + mitigations, and a task checklist mirroring this plan.

- [ ] **Step 5: Commit**
```bash
git add .env.example apps/discord-bot/README.md
git commit -m "docs(discord-bot): document channels SDK flag + cutover"
```

---

## Self-Review

- **Spec coverage:** Goals 1–4 → Tasks 2–6 (transport/render swap behind flag) + Task 7 (rollout). Inbound mapping table → Task 3 (thread-start/reply), Task 4 (commands), Task 5 (buttons), Task 3 (ack + shadow mode). Outbound seam → Task 6. Risks 1–4 → Task 1 (ingress, gating), Task 5 (interaction durability via fixed ids), Task 6 (render-only outbound), Tasks 4/3 (command + shadow parity). GitHub non-goal → untouched. Testing section → per-task unit/integration + Task 7 manual. Deliverables 1–7 → Tasks 1–7. No gaps.
- **Placeholder scan:** The `any`-typed turn/ctx params and the "field names confirmed in Task 1" notes are deliberate — Task 1 is a spike whose *Produces* block pins the exact SDK types the later tasks consume; not TODOs. All code steps show real code.
- **Type consistency:** `toInboundMessage`, `registerInbound`, `registerCommands`, `registerInteractions`, `markIssueSolved`, `requestMoreHelp`, `buildDiscordBody`, `readUseChannelsSdk`, `createChannelsBot` are each defined once and referenced consistently. `InboundMessage` fields match `types.ts`. `FormattedResponse` fields match `types.ts`.

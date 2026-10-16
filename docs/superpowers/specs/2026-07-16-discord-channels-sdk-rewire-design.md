# Rewire the Discord Layer to `@copilotkit/channels` (P0)

## Context

Outpost's channel integrations are hand-rolled today. The Discord bot (`apps/discord-bot`)
owns a stateful `discord.js` gateway `Client`, a set of event handlers
(`events/thread-create.ts`, `events/message-create.ts`, `events/interaction-create.ts`,
`events/ready.ts`, `events/guild-member-add.ts`), slash commands (`commands/{escalate,assign,priority,close}.ts`
registered via `register-commands.ts`), and button interactions (`interactions/buttons.ts`).
Outbound AI replies are posted **from the worker**, not the bot: `apps/worker` processes
`AI_RESPONSE` jobs and calls `getAdapter(DISCORD).postResponse(...)`, which is the
stateless REST adapter in `packages/outpost/shared/src/platforms/discord.ts` (hand-rolled
2000-char splitting + ActionRow building).

CopilotKit now ships [`@copilotkit/channels`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels)
(umbrella over `@copilotkit/channels-core` + per-platform adapters incl. `@copilotkit/channels-discord`).
It is an **agent-runtime + transport + rendering** framework: `createChannel({ adapters, agent, tools, context })`,
`bot.onMention(({ thread }) => thread.runAgent())`. The SDK owns the Discord gateway, JSX→Components V2
rendering, streaming, interactions/HITL, and slash-command registration.

Tracking dashboard: [Rewiring to Channels SDK](https://www.notion.so/copilotkit/Rewiring-to-Channels-SDK-39f3aa3818528004b3a0c3ee79282ff7)
(Notion, child of the Outpost page). To be populated by this work.

### Key finding that shapes scope

**The Channels SDK has no GitHub adapter.** It covers live chat surfaces only — Slack, Teams,
Discord, Telegram, WhatsApp. GitHub is webhooks + reaction polling, not a gateway surface, so it
cannot sit on the SDK the way Discord can. **GitHub is therefore out of scope for P0** and tracked
as a follow-up (either leave it on the current custom adapter or author a GitHub `PlatformAdapter`
against `channels-core`'s interface later).

## Goals

1. Replace the Discord-facing I/O layer of the engine (gateway transport, event handling,
   interactions, message rendering) with `@copilotkit/channels` + `@copilotkit/channels-discord`.
2. Keep Outpost's ticket/queue/worker/AI pipeline **unchanged** underneath — the SDK is used as
   Discord transport + JSX rendering, **not** as the agent runtime (`thread.runAgent()` is never called).
3. Preserve full behavior parity: forum-post → ticket, thread reply → ticket reply, the four slash
   commands, button feedback, shadow mode, and worker-posted AI replies.
4. Ship behind an env flag so cutover is per-environment and reversible.

## Non-goals

- **GitHub** — deferred to a follow-up (SDK ships no GitHub adapter; see above).
- **Slack / Teams / Email** — not touched in P0.
- **Using the SDK's agent runtime.** We deliberately do NOT wrap Outpost's AI pipeline as an
  AG-UI agent or stream replies live via `thread.runAgent()`. Outbound stays async through the
  ticket → queue → worker path. (Native-agent-runtime is a possible future, not this PR.)
- **Durable `ActionStore` as a general feature** — only what's needed for Discord button parity
  (see Risk 2).

## Design

### Architecture — the "bridge"

Two seams change; everything else stays.

**Seam 1 — Inbound (`apps/discord-bot`).** Replace the hand-rolled `discord.js Client` +
`events/*` + `interactions/*` + `commands/*` with `createChannel({ adapters: [discord({...})] })`.
No `agent` is registered. SDK handlers translate each turn into Outpost's `InboundMessage`
(`packages/outpost/shared/src/platforms/types.ts`) and call the **existing**
`InboundHandler.handle()` (`packages/outpost/shared/src/platforms/inbound.ts`) — identical ticket
creation, find-or-create user, team-member detection, and `AI_RESPONSE` job enqueue as today.
The ticket ack is posted via `thread.post(<Message/>)`.

**Seam 2 — Outbound (`apps/worker` + `shared/platforms/discord.ts`).** The worker still processes
`AI_RESPONSE` jobs and calls `getAdapter(DISCORD).postResponse(...)`. We swap the adapter's
hand-rolled splitting / ActionRow construction for the SDK render path
(`renderDiscordMessage(ir)` → `{ components, flags }` from `@copilotkit/channels-discord`) posted
via `discord.js` REST. The worker has no live gateway, so this stays **render-only + stateless REST**.

**Unchanged:** Ticket/Message/User model, `InboundHandler`, `packages/outpost/queue`,
`apps/worker` job loop, AI pipeline ("Pathfinder" in `packages/outpost/ai`), Linear/GitHub sync
(`shared/src/sync`), SLA, dispatch/on-call routing.

### Inbound behavior mapping

| Outpost today | SDK hook | Bridge action |
|---|---|---|
| New forum post → new ticket (`isThreadStart: true`) | `onThreadStarted` / `onMessage` (first msg) | build `InboundMessage(isThreadStart: true)` → `InboundHandler.handle` |
| Reply in tracked thread → ticket reply | `onMessage` | `InboundMessage(isThreadStart: false)` → `InboundHandler.handle` |
| Slash cmds: `escalate` / `assign` / `priority` / `close` | `onCommand` | map each to the existing command logic in `commands/*` |
| Button feedback ("Issue Solved" / "Need more help") | `onInteraction` + `ActionStore` | map to existing `interactions/buttons.ts` logic |
| Ticket-created ack | `thread.post(...)` | replaces bot-side `postSystemMessage` |
| Shadow mode (record silently, no visible posts) | suppress all `thread.post` | preserve `lib/shadow-mode.ts` flag |

### Rollout & safety

- Behind env flag `DISCORD_USE_CHANNELS_SDK` (default `false`). When set, `apps/discord-bot`
  boots the SDK path; otherwise the legacy path. Cut over per-environment (dev → staging → prod)
  and roll back by unsetting.
- The legacy path stays in-tree until parity is verified in staging. Deleting it (completing the
  "full cutover") may be a fast-follow PR to keep this one reviewable.
- Align `discord.js` versions: Outpost uses `^14`, SDK uses `^14` — pin to one to avoid a
  duplicate install / two `Client` classes.

## Risks — verified first in the PR (spike step, before bulk work)

1. **Ingress model mismatch (top risk, gating).** The SDK's Discord listener pre-filters ingress
   to **@-mentions** (guild channels and DMs). Outpost is **forum/channel-monitored**
   (`MONITORED_CHANNEL_IDS`): a new forum post is a new ticket and every reply in a tracked thread
   is a ticket reply — no mention required. First task: confirm whether `ListenerConfig` /
   `attachDiscordListener` / the exported `ClientLike` primitive can broaden ingress to
   monitored-channel + forum-thread-start turns. If not configurable, fall back to attaching our
   own listener over the SDK's `ClientLike` (and file an upstream ask). **Resolve before bulk work.**
2. **Interaction durability.** The SDK's `ActionStore` is in-memory — inline button handlers
   expire on restart ("this action expired"). Outpost's feedback buttons must survive restarts.
   Mitigation: supply a durable `ActionStore` (DB-backed) or keep self-describing button ids that
   don't rely on the in-memory snapshot.
3. **Outbound from a separate process.** The worker has no live gateway `Thread`. Confirm
   `renderDiscordMessage` / `renderComponents` are usable standalone (render-only), then POST via
   REST from the worker — no `createChannel` in the worker.
4. **Slash-command + shadow-mode parity.** All four commands must map to `onCommand`; shadow mode
   must suppress every outbound post on the SDK path.

## Testing

- **Unit:** turn → `InboundMessage` mapping; adapter render snapshot (`renderDiscordMessage` output).
- **Integration:** use `@copilotkit/channels/testing` to drive turns with no live gateway; assert
  `InboundHandler` is called with the correct `InboundMessage` and the `AI_RESPONSE` job is enqueued.
- **Manual:** run the bot against a test guild/forum with the flag on — new post → ticket, reply →
  ticket reply, each slash command, button feedback, and worker-posted AI reply.

## Deliverables in this PR

1. Add deps (`@copilotkit/channels`, `@copilotkit/channels-discord`) and align `discord.js`.
2. Resolve Risk 1 (ingress spike) and record the outcome.
3. SDK-backed inbound in `apps/discord-bot` behind `DISCORD_USE_CHANNELS_SDK`.
4. Outbound rendering swapped in `shared/platforms/discord.ts` to the SDK render path.
5. Port the four slash commands + button feedback; preserve shadow mode.
6. Tests (unit + integration).
7. Populate the Notion dashboard with scope, risks, and a checklist.

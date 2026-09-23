# Discord Channels SDK — Ingress Findings

**Question:** can `@copilotkit/channels-discord` (as of `CopilotKit/CopilotKit@main`) deliver forum-channel-monitored, NON-mention ingress — a new forum post in a monitored parent channel → a "thread-start" turn, and every non-bot reply in a tracked thread → a "reply" turn, scoped to a set of monitored channel IDs, with no `@`-mention required?

Source read directly from GitHub (`CopilotKit/CopilotKit@main`):
- `packages/channels-discord/src/discord-listener.ts`
- `packages/channels-discord/src/adapter.ts`
- `packages/channels-discord/src/types.ts`
- `packages/channels-discord/src/render/components-v2.ts`
- `packages/channels-core/src/create-channel.ts`
- `packages/channels-core/src/platform-adapter.ts` (pulled in addition — `create-channel.ts` imports `IngressSink`/`IncomingThreadStart`/`IncomingTurn` from here, and Branch B's mechanism can't be specified precisely without it)
- `packages/channels-discord/src/index.ts` + `package.json` (to confirm the public export surface / import path)

## 1. Verdict

**(B) — requires attaching our own listener over the exported `ClientLike` (or an equivalent custom `PlatformAdapter`).** The SDK cannot be configured into forum/non-mention ingress through `createChannel`/`discord()` options; the mention gate and the total absence of a `threadCreate` subscription are hardcoded in `discord-listener.ts` with no config knob to disable either.

Two compounding gaps, both in the load-bearing file:

1. **No forum/thread-create ingress at all.** `attachDiscordListener` only ever calls `client.on(...)` for `"messageCreate"`, `"interactionCreate"`, `"messageReactionAdd"`, `"messageReactionRemove"`. There is no `"threadCreate"` subscription anywhere in `channels-discord`. A new forum post is invisible to the SDK's ingress path, full stop.
2. **Mention gate is hardcoded, unconditional, and unconfigurable.** Every `messageCreate` is filtered through `shouldAnswer`, which requires a DM or a literal `@bot` mention — there is no monitored-channel-id allowlist and no way to pass "answer without a mention."

## 2. Evidence

`packages/channels-discord/src/discord-listener.ts` — the entire ingress registration:

```ts
export function attachDiscordListener(cfg: ListenerConfig): void {
  const { client, botUserId, onTurn, onCommand, onReaction, commandPending } =
    cfg;

  client.on("messageCreate", (msg: MessageLike) => {
    const botId = typeof botUserId === "function" ? botUserId() : botUserId;
    if (!shouldAnswer(msg, botId)) return;
    const replyTarget = {
      channelId: msg.channelId,
      ...(msg.guildId ? { guildId: msg.guildId } : {}),
    };
    void Promise.resolve(
      onTurn({
        conversationKey: msg.channelId,
        replyTarget,
        userText: stripMention(msg.content, botId),
        senderUserId: msg.author.id,
      }),
    ).catch((e) => console.error("[bot-discord] onTurn handler failed:", e));
  });

  client.on("interactionCreate", async (i: ChatInputLike) => { ... });

  if (onReaction) {
    client.on("messageReactionAdd", handleReaction(true));
    client.on("messageReactionRemove", handleReaction(false));
  }
}
```

That is the **complete list of Gateway events the file subscribes to** — `messageCreate`, `interactionCreate`, `messageReactionAdd`/`Remove`. No `threadCreate`. Compare with Outpost's own `apps/discord-bot/src/events/thread-create.ts`, whose entire job is to react to a discord.js `threadCreate` event that the Channels SDK never listens for.

The mention filter, verbatim:

```ts
/** Answer @-mentions and DMs; skip our own messages and other bots. */
function shouldAnswer(msg: MessageLike, botUserId: string): boolean {
  if (msg.author.id === botUserId) return false;
  if (msg.author.bot) return false;
  if (msg.channel.isDMBased()) return true;
  // Only answer a DIRECT user mention. discord.js `mentions.has()` also returns
  // true for role mentions and @everyone/@here that happen to include the bot,
  // so narrow to the explicit user-mention set.
  return msg.mentions.users?.has?.(botUserId) ?? false;
}
```

This is a private, module-level function — **not** part of `ListenerConfig` and not passed in from `adapter.ts`. There is no option on `DiscordAdapterOptions` (`botToken`, `appId`, `guildId`, `interruptEventNames` — the complete list, per `adapter.ts`) that disables it, and no monitored-channel-id list anywhere in the adapter's option surface. A message in a tracked forum thread with no `@mention` is dropped before `onTurn` is ever called — the `shouldAnswer` early-return happens synchronously inside the `messageCreate` handler, upstream of everything else.

Compare with what Outpost's own bot does (`apps/discord-bot/src/events/message-create.ts`):

```ts
export async function handleMessageCreate(message: Message): Promise<void> {
    // Ignore messages from bots
    if (message.author.bot) return;
    // Only process messages in threads (forum posts are threads)
    if (message.channel.type !== ChannelType.PublicThread && message.channel.type !== ChannelType.PrivateThread) {
        return;
    }
    ...
    if (!ticket) return; // this thread isn't tracked as a ticket, ignore it
    ...
}
```

No mention check anywhere — gating is purely "is this a tracked thread," which is exactly the behavior the SDK's `shouldAnswer` cannot produce.

`createChannel`'s public `Channel` interface (`packages/channels-core/src/create-channel.ts`) does expose `onThreadStarted(h: ThreadStartHandler)`, and `IngressSink.onThreadStarted` is wired through:

```ts
async onThreadStarted(evt: IncomingThreadStart) {
  const thread = makeThread(adapter, evt.replyTarget, evt.conversationKey);
  for (const h of threadStartedHandlers) await h({ thread, user: evt.user });
},
```

But `DiscordAdapter.start()` (`adapter.ts`) never calls `sink.onThreadStarted(...)` — it only wires `onTurn`, `onCommand`, and `onReaction` through `attachDiscordListener`. `onThreadStarted` exists in the core engine for adapters that model a "conversation surface opened" lifecycle event (the doc comment says explicitly: *"e.g. the Slack assistant pane"*), and Discord's adapter simply doesn't emit it. Even if it did, `IncomingThreadStart` (see `platform-adapter.ts`) only carries `conversationKey`, `replyTarget`, `user`, `platform` — no message text, no starter-message content — so it isn't a drop-in vehicle for "new forum post" ingress the way we need it (we need the starter message's text and author to hand off to the ticket-creation path).

## 3. The mechanism to use (Branch B)

Since neither `createChannel` options nor `discord()`'s `DiscordAdapterOptions` expose a way to reconfigure `shouldAnswer` or add `threadCreate`, and `DiscordAdapter`'s internal `discord.js` `Client` is a **private field** (`private readonly client: Client;` in `adapter.ts` — never exposed on the `PlatformAdapter`/`DiscordAdapter` public surface), the only viable path is:

**Do not call `attachDiscordListener` for ingress.** Instead, own a raw `discord.js` `Client` directly (as Outpost's `apps/discord-bot` already does) and drive the SDK's `IngressSink` contract ourselves, by implementing a custom `PlatformAdapter` (or reusing `DiscordAdapter` for egress only, per Task 6).

Exact exported surface to build against (`packages/channels-discord/src/index.ts` confirms these are public, importable as `@copilotkit/channels-discord`):

```ts
export interface ClientLike {
  on(event: "messageCreate", cb: (msg: MessageLike) => void): void;
  on(event: "interactionCreate", cb: (i: ChatInputLike) => void): void;
  on(
    event: "messageReactionAdd" | "messageReactionRemove",
    cb: (reaction: unknown, user: unknown) => void,
  ): void;
  on(event: string, cb: (arg: unknown) => void): void;
}

export interface ListenerConfig {
  client: ClientLike;
  botUserId: string | (() => string);
  onTurn(turn: IncomingTurn): void | Promise<void>;
  onCommand(cmd: IncomingCommandRaw): void | Promise<void>;
  onReaction?: (evt: IncomingReaction) => void | Promise<void>;
  commandPending?: PendingInteractions;
}

export function attachDiscordListener(cfg: ListenerConfig): void;
```

`ClientLike.on(event: string, cb: (arg: unknown) => void): void` is a deliberate escape hatch (the loose overload at the end of the interface) — it means a `discord.js` `Client` satisfies `ClientLike` for **any** event, including `"threadCreate"`, even though the interface only types the three events `attachDiscordListener` itself subscribes to. That confirms the intended pattern: write our OWN attach function (mirroring `attachDiscordListener`'s shape but not calling it) that:

1. Subscribes to `client.on("threadCreate", (thread, newlyCreated) => ...)` — filter to `newlyCreated`, filter `thread.parentId` against `MONITORED_CHANNEL_IDS`, filter `thread.type` to `PublicThread`/`PrivateThread` (mirrors `apps/discord-bot/src/events/thread-create.ts` exactly) — fetch the starter message, then call the core `IngressSink.onTurn(...)` directly (bypassing `onThreadStarted` entirely, since it carries no message text) for the **thread-start turn**.
2. Subscribes to `client.on("messageCreate", (msg) => ...)` with **no mention check** — only `!msg.author.bot` and "is `msg.channel.id` a thread we're tracking" (mirrors `apps/discord-bot/src/events/message-create.ts`) — then calls `IngressSink.onTurn(...)` for the **reply turn**.

`IngressSink` (from `@copilotkit/channels-core`, `platform-adapter.ts`) is the contract to satisfy directly:

```ts
export interface IngressSink {
  onTurn(turn: IncomingTurn): void | Promise<void>;
  onInteraction(evt: InteractionEvent): void | Promise<void>;
  onCommand(cmd: IncomingCommand): void | Promise<void>;
  onThreadStarted(evt: IncomingThreadStart): void | Promise<void>;
  onReaction(evt: IncomingReaction): void | Promise<void>;
  onModalSubmit(evt: IncomingModalSubmit): Promise<ModalSubmitResult | void>;
  onModalClose(evt: IncomingModalClose): void | Promise<void>;
}
```

`createChannel`'s `makeSink(adapter)` (`create-channel.ts`) is the only thing that ever constructs a real `IngressSink`, and it hands that sink to `adapter.start(sink, ctx)` — so to get our custom ingress wired through the same `Channel` (with its lock/dedup/identity/transcript machinery), the concrete mechanism is: **implement `PlatformAdapter.start(sink, ctx)` ourselves** (satisfying the interface in `platform-adapter.ts` — `platform`, `capabilities`, `ackDeadlineMs`, `start`, `stop`, `render`, `post`, `update`, `stream`, `delete`, `createRunRenderer`, `decodeInteraction`, `lookupUser`, `conversationStore`), where `start()` attaches the two custom listeners above and calls `sink.onTurn(...)` for both cases, then pass that adapter to `createChannel({ adapters: [ourAdapter] })` in place of (or alongside, for egress) `discord(opts)`.

Note there is no "kind" discriminator on `IncomingTurn` to distinguish thread-start from reply at the type level — `create-channel.ts` says so explicitly: *"v1 routing: there is no turn `kind`, so prefer mention handlers; if none are registered, fall back to message handlers."* Our bridge (Task 3) must track the thread-start/reply distinction itself (e.g. "first turn for this `conversationKey`" or an explicit branch in our custom adapter's two listeners), the same way `apps/discord-bot`'s `handleThreadCreate` vs `handleMessageCreate` are two separate call sites today — the SDK gives us nothing for this for free.

## 4. Turn shapes

Channels-discord's own local types (`packages/channels-discord/src/types.ts` — used internally by `attachDiscordListener`/`discord-listener.ts`, distinct from channels-core's):

```ts
export interface ReplyTarget {
  channelId: string;
  guildId?: string; // present for guild channels/threads; absent for DMs
}

export interface IncomingTurn {
  conversationKey: string;
  replyTarget: ReplyTarget;
  userText: string;
  senderUserId?: string;
}

export function conversationKeyOf(target: ReplyTarget): string {
  return target.channelId;
}
```

Channels-core's canonical types (`packages/channels-core/src/platform-adapter.ts` — what a `PlatformAdapter.start(sink)` must actually call `sink.onTurn` with):

```ts
export interface IngressEventBase {
  conversationKey: string;
  replyTarget: ReplyTarget; // opaque `unknown` at the core level
  user?: PlatformUser;
}
export interface IngressIds {
  eventId?: string;
  turnId?: string;
  deliveryId?: string;
}
export interface IncomingTurn extends IngressEventBase, IngressIds {
  userText: string;
  contentParts?: AgentContentPart[];
  platform: string;
}
export interface IncomingThreadStart extends IngressEventBase {
  platform: string; // no message text — lifecycle-only ("conversation opened")
}
```

Field-name summary against the question's requirements:
- **user id** → `senderUserId` (discord-local `IncomingTurn`) → resolved to `user: PlatformUser { id, name, handle }` (core-level, via `DiscordAdapter.resolveUser`).
- **username** → `PlatformUser.name` / `PlatformUser.handle` (resolved from Discord's `globalName`/`username`), not carried on the raw turn itself.
- **text** → `userText`.
- **threadId / channelId** → both collapse to `ReplyTarget.channelId` (Discord addresses channels and threads by the same id space) and `conversationKeyOf(target) === target.channelId`. There is no separate `threadId` field — `conversationKey` **is** the thread id for a forum-thread conversation.
- **url** → not present on any turn/reply-target type. Not modeled anywhere in this SDK slice — would need to be constructed by the bridge (`https://discord.com/channels/<guildId>/<channelId>`) if needed downstream.
- **thread-start vs reply distinction** → **not modeled**. As noted in §3, there is no `kind` discriminator on `IncomingTurn`; both a thread-start and a reply are the same shape. This has to be tracked by our own custom adapter/bridge logic (Task 3), not the SDK.

## 5. Outbound render

Import path (public, confirmed via `packages/channels-discord/src/index.ts` + `package.json`'s single `"."` export):

```ts
import { renderDiscordMessage, renderComponents } from "@copilotkit/channels-discord";
```

Signatures (`packages/channels-discord/src/render/components-v2.ts`):

```ts
export function renderComponents(ir: ChannelNode[]): ContainerBuilder;

/** Ready-to-send payload for channel.send / message.edit. */
export function renderDiscordMessage(ir: ChannelNode[]): {
  components: ContainerBuilder[];
  flags: number; // MessageFlags.IsComponentsV2
};
```

Confirmed: `renderDiscordMessage(ir)` returns exactly `{ components, flags }` — a single-element `components` array wrapping one top-level `ContainerBuilder`, `flags` fixed to `MessageFlags.IsComponentsV2`. `DiscordAdapter.post`/`.update`/`.postEphemeral` all destructure it identically:

```ts
const { components, flags } = renderDiscordMessage(ir);
const msg = await channel.send({ components, flags });
```

This is usable as-is for Task 6 regardless of the ingress verdict — rendering/egress is orthogonal to the ingress gap found here, and `DiscordAdapter` (or `discord()`) can still be used for `post`/`update`/`stream`/`render` even if a custom adapter/listener handles ingress.

## 6. Implications for the bridge

- **Ingress must bypass `attachDiscordListener` and `DiscordAdapter.start()` entirely** for the inbound path. Neither `createChannel`'s options nor `DiscordAdapterOptions` expose a monitored-channel allowlist or a way to disable the mention gate — the gap is structural (hardcoded `shouldAnswer`, no `threadCreate` subscription), not a missing config flag we can pass around.
- **Reuse Outpost's existing filter logic wholesale.** `apps/discord-bot/src/events/thread-create.ts` (monitored-parent + `PublicThread`/`PrivateThread` check) and `message-create.ts` (bot-check + tracked-thread check, no mention) already implement exactly the semantics the SDK lacks — port them into the custom `PlatformAdapter`'s `start()` rather than re-deriving them.
- **The bridge owns the thread-start/reply distinction**, since `IncomingTurn` has no `kind` field and `IncomingThreadStart` carries no message text. Two separate call sites (mirroring today's two event handlers) each construct and dispatch their own `IngressSink.onTurn(...)`, rather than relying on any SDK-level routing.
- **Egress can still use the real `DiscordAdapter`/`discord()`** (`post`, `update`, `stream`, `render` via `renderDiscordMessage`) — the finding here only blocks the *ingress* half. A split design (custom adapter/listener for inbound, `discord()`-backed adapter — or the same custom adapter delegating to `DiscordAdapter`'s internals — for outbound) is workable and keeps Task 6's rendering work unaffected.
- **Risk:** building a custom `PlatformAdapter` from scratch means re-implementing (or vendoring) parts of `DiscordAdapter` we still want (conversation history via `fetchHistory`, `resolveUser`, reaction/interaction handling) — there's no supported "extend `DiscordAdapter` and only override ingress" seam; its `client`, `pending`, `commandPending` fields are all private. Wave 2's spike should verify whether composing two adapter instances (one custom for `onTurn`, one real `DiscordAdapter` registered only for post/update, never started against the same client) is viable, or whether full duplication is required.
- **Risk:** no upstream issue exists yet for "forum/non-mention ingress" as a first-class SDK feature (not checked against CopilotKit's issue tracker in this pass) — if Outpost wants this to eventually be Branch A (native SDK support), that would need to be filed upstream; today's workaround is entirely bridge-side.

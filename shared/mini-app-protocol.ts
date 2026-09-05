/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The Mini App bridge protocol — how an embedded, remotely-hosted app talks to
 * Thunderbolt.
 *
 * **Why JSON-RPC 2.0 over `postMessage`.** The app already speaks JSON-RPC 2.0
 * to agents (`backend/src/haystack/acp-server.ts` implements ACP over a
 * WebSocket), so this is one wire idiom in the codebase rather than two. The
 * handshake deliberately mirrors ACP's `initialize`: each side announces its
 * protocol version and a capability set, and neither assumes anything the other
 * did not declare.
 *
 * **Why the capability handshake matters more than the method list.** The whole
 * point of this surface is that onboarding a customer app is "add a registry
 * entry", not "extend the API". Methods can be added forever without breaking
 * deployed apps; a bad envelope cannot be fixed without breaking all of them. So
 * the method set here is deliberately tiny and the negotiation is the part built
 * to last. App-exposed tools arrived that way — a `tools` capability flag, which
 * an app that doesn't declare keeps working untouched, on the same wire version.
 *
 * Trust model: the host never trusts the frame. Every inbound message is checked
 * for source window and origin by the host bridge, then parsed with the schemas
 * below. Anything that fails is dropped.
 *
 * **Bounds clamp, they don't reject.** Dropping a message is the right answer
 * for a malformed *shape*, and the wrong one for a string that ran long: the
 * guest doesn't know our prompt budgets and none of the bridges clamps to them,
 * so a `.max()` here turns "your table row was wide" into "the feature silently
 * does nothing". Length bounds therefore go through {@link clampedString}, and
 * collections are parsed per element so one bad member costs that member rather
 * than the payload. See `parseToolsList` for the case that taught us this.
 */

import { z } from 'zod'

import { clampedString } from './lib/clamped-string'

/**
 * Discriminator stamped on every message. `postMessage` is a shared bus — React
 * DevTools, Vite HMR, browser extensions and the page's own libraries all post
 * to the same window — so messages without this marker are ignored rather than
 * parsed and rejected.
 */
export const miniAppProtocolMarker = 'thunderbolt-miniapp'

/**
 * Wire version. Bump only for a breaking envelope change; adding a method or an
 * optional capability is backwards compatible and must not bump it.
 *
 * v2 renamed every method to the `ui/` namespace — see the note below.
 *
 * **Why the `ui/selection-query` → `ui/element-at` rename did not bump this.**
 * A method rename *is* breaking: an out-of-date guest handshakes on 2, then has
 * no handler for the new name, and selection fails silently rather than loudly.
 * It is only safe because the rename and the SDK landed together — the canonical
 * SDK (`thunderbolt-miniapp-template`) answers `ui/element-at` on version 2, and
 * no guest ever shipped speaking 2 with the old name. There is no third-party
 * guest to strand yet. Once one exists, that argument expires: a renamed or
 * removed method has to bump this, so the handshake rejects an old guest with a
 * reason instead of leaving a feature quietly dead.
 */
export const miniAppProtocolVersion = 2

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  METHOD NAMING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Names follow **MCP Apps** (the first official MCP extension, spec 2026-01-26)
 * wherever the semantics genuinely match: `ui/initialize`,
 * `ui/update-model-context`, and MCP's own `tools/list` / `tools/call`. A
 * `ui/notifications/` prefix marks a fire-and-forget message in either direction,
 * which is their convention too.
 *
 * We do not implement MCP Apps itself, and the divergence is deliberate rather
 * than incidental — it delivers UI as an HTML string over a `ui://` resource,
 * rendered inside a sandbox proxy, which leaves the app with no origin of its
 * own. No origin means no cookies, no same-origin calls to its own backend and
 * nowhere for an OIDC redirect to land, and its lifecycle is a widget attached
 * to one tool result rather than an application the user navigates. A Mini App
 * is a cooperative app deployed at a real URL, so it keeps all of that.
 *
 * Where they have no equivalent we stay in the same namespace and pick our own
 * name rather than bending theirs to fit: `ui/open-chat` (their `ui/message`
 * *sends* a message; ours opens the panel and seeds the composer) and the
 * `ui/…selection…` pair, which has no counterpart at all.
 *
 * Adopting the vocabulary now is cheap and gets expensive later: today there are
 * two guest apps and both are ours.
 */

/** Methods the guest app sends to Thunderbolt. */
export const miniAppGuestMethods = {
  /** Handshake. Must be the guest's first message. */
  initialize: 'ui/initialize',
  /** "Here is what the user is looking at now." Fire-and-forget. */
  contextUpdate: 'ui/update-model-context',
  /** Ask the host to open the chat panel, optionally seeded with a prompt. */
  chatOpen: 'ui/open-chat',
  /** The user selected (or deselected) text inside the app. */
  selectionChanged: 'ui/notifications/selection-changed',
  /**
   * "My identity token is about to expire; give me another."
   *
   * Guest-initiated rather than pushed on a timer: only the app knows whether
   * it still needs one, and a host pushing tokens into a frame that stopped
   * caring is just a token with a longer life and a wider blast radius.
   */
  requestAuthToken: 'ui/request-auth-token',
  /**
   * "Something threw in here." Fire-and-forget.
   *
   * Artifacts already report runtime errors, so a broken artifact says so while
   * a broken app just sits there looking fine — the host cannot see into a
   * cross-origin frame and read `window.onerror` for itself (THU-852). An app
   * that wants the same treatment forwards its own errors here.
   */
  runtimeError: 'ui/notifications/error',
} as const

/** Methods Thunderbolt sends to the guest app. */
export const miniAppHostMethods = {
  /**
   * Some part of the host's ambient state changed — theme, locale, the surface
   * it's running on. Carries a *partial* {@link MiniAppHostContext}: only the
   * keys that moved, so adding a field later doesn't force every guest to
   * re-read the whole object.
   */
  hostContextChanged: 'ui/notifications/host-context-changed',
  /**
   * "What is under this point?" — sent as the user moves the pointer over the
   * app in pick mode. The *interaction* is entirely the host's (it captures the
   * pointer, draws the outline and the label, and decides what counts as a
   * click); the guest only resolves a coordinate to the element there, because
   * only it can see its own DOM.
   *
   * This replaced a rect-based `ui/selection-query`, where the user dragged a
   * marquee and the guest returned everything inside it. Highlighting the one
   * element under the cursor is both easier to aim and easier for an app to
   * answer well: a rect forces the guest to guess which of the overlapping
   * things the user meant, and it answered with a list nobody had reviewed.
   */
  elementAt: 'ui/element-at',
  /** Discover the tools the app exposes to the model. Sent once, after handshake. */
  toolsList: 'tools/list',
  /** Invoke one of them. */
  toolsCall: 'tools/call',
} as const

/**
 * What the guest declares it can do.
 *
 * Additive by design: an unknown key from a newer guest is stripped rather than
 * rejected, so a capability can ship on one side before the other. Every field
 * is consulted by the host — a declaration that changed nothing would be worse
 * than no declaration, because it would read like a control.
 */
export const miniAppGuestCapabilitiesSchema = z
  .object({
    /** The app exposes callable tools. The host only runs `tools/list` when this
     *  is declared, so an app that has none is never asked. */
    tools: z.boolean().optional(),
    /**
     * The app reports text selections via `ui/notifications/selection-changed`, so the host can
     * float a "Chat" control over highlighted text. Declared rather than assumed:
     * an app that never sends selections shouldn't have the host waiting for them.
     */
    selection: z.boolean().optional(),
    /**
     * The app wants to know who the user is. Declared rather than assumed so an
     * app that needs no identity never causes a token to be minted — the cheapest
     * secret is the one that was never issued.
     */
    auth: z.boolean().optional(),
  })
  .default({})

export type MiniAppGuestCapabilities = z.infer<typeof miniAppGuestCapabilitiesSchema>

/** What the host offers the guest, returned from `initialize`. */
export type MiniAppHostCapabilities = {
  /** The host will surface `ui/update-model-context` payloads to the model. */
  context: boolean
  /** The host honours `ui/open-chat`. */
  chat: boolean
  /**
   * The host will answer `ui/request-auth-token` for this app.
   *
   * Deliberately *not* "the token in this reply arrived": the mint is a network
   * call on the handshake's critical path, and reporting `false` because one
   * attempt failed tells a guest to stop asking — which is what `false` means
   * here — over what is usually a transient error. A guest that declared `auth`
   * and got no `auth` field should retry; one told `auth: false` should give up
   * and say so.
   */
  auth: boolean
}

/**
 * Ceiling on a serialised `data` or `selection` payload, in characters.
 *
 * `data` has to stay arbitrary structure — that is what lets an app forward the
 * state it already has instead of writing a second one for us — but arbitrary
 * structure is not the same as arbitrary size. Everything else a guest can hand
 * over is bounded (`summary` 20k, `title` 200, a runtime error 500), and this is
 * the one field that reaches the model verbatim on every `get_app_context`
 * call, so an app that publishes its whole store would otherwise put an
 * unbounded blob in the context window on every read and bill the user for it.
 *
 * Applied at format time rather than at parse: an over-sized `data` costs the
 * model that field, not the `title` and `summary` the author wrote for it, and
 * the model is told the payload was withheld rather than left to assume the app
 * has no state. Roughly the same order as `summary`, for the same reason.
 */
export const maxContextPayloadChars = 20_000

/**
 * The payload the chat reasons about — the heart of the protocol.
 *
 * `summary` and `data` are deliberately separate. `summary` is prose written for
 * a model to read; `data` is whatever structure the app already has. Apps that
 * only manage the first still work, and apps that dump raw state still work,
 * because the host never has to interpret `data` — it forwards it.
 */
export const miniAppContextSchema = z.object({
  /** Short human label for the current view. Also used as panel chrome. */
  title: clampedString(200),
  /** Model-facing prose describing what the user is looking at.
   *  Clamped, not capped: an app that builds its summary from its data (one
   *  line per node, say) grows past this with no idea the bound exists, and
   *  rejecting cost the model the whole context update — so `get_app_context`
   *  went on describing the previous view as if nothing had changed. */
  summary: clampedString(20_000),
  /** Arbitrary app-defined state. Never interpreted by the host.
   *  Dropped from the model's view past {@link maxContextPayloadChars} serialised. */
  data: z.unknown().optional(),
  /** What is focused/selected right now, when the app has a notion of it.
   *  Bounded the same way as `data`. */
  selection: z.unknown().optional(),
})

export type MiniAppContext = z.infer<typeof miniAppContextSchema>

/** JSON-RPC id. Notifications omit it entirely. */
const jsonRpcIdSchema = z.union([z.string(), z.number()])

/** Shared envelope fields on every message in both directions. */
const envelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  protocol: z.literal(miniAppProtocolMarker),
})

/** `initialize` — guest → host request. */
export const initializeRequestSchema = envelopeSchema.extend({
  id: jsonRpcIdSchema,
  method: z.literal(miniAppGuestMethods.initialize),
  params: z.object({
    protocolVersion: z.number().int().positive(),
    /** Display name the app reports for itself; host chrome may show it.
     *  Clamped rather than capped because this rides the *handshake*: rejecting
     *  it dropped `initialize` itself, so a long display name meant the app
     *  never connected and both sides only ever saw a timeout. */
    appName: clampedString(200).optional(),
    capabilities: miniAppGuestCapabilitiesSchema,
  }),
})

/** `ui/update-model-context` — guest → host notification (no id, no reply). */
export const contextUpdateNotificationSchema = envelopeSchema.extend({
  method: z.literal(miniAppGuestMethods.contextUpdate),
  params: z.object({ context: miniAppContextSchema }),
})

/** `ui/notifications/error` — guest → host notification (no id, no reply). */
export const runtimeErrorNotificationSchema = envelopeSchema.extend({
  method: z.literal(miniAppGuestMethods.runtimeError),
  params: z.object({
    // Bounded because it lands in a one-line strip, and an untrusted frame
    // should not be able to hand us an unbounded string to hold. The bridges do
    // slice to 500 before sending, but a hand-rolled one reporting a long stack
    // trace should get a truncated strip, not silence about its own crash.
    message: clampedString(500, { min: 1 }),
  }),
})

/** `ui/open-chat` — guest → host request. */
export const chatOpenRequestSchema = envelopeSchema.extend({
  id: jsonRpcIdSchema,
  method: z.literal(miniAppGuestMethods.chatOpen),
  params: z
    .object({
      /** Seed the composer with this text (not auto-sent). Clamped: seeding the
       *  composer with a document excerpt is exactly what this is for, and a
       *  rejected request never settles — the chat panel just never opens. */
      prompt: clampedString(10_000).optional(),
    })
    .default({}),
})

/**
 * Where a selection sits, in the *guest's own viewport* coordinates — i.e. what
 * `getBoundingClientRect()` returns inside the frame, already accounting for the
 * app's internal scroll. The host maps this onto its own layout to float a
 * control over the highlighted text.
 */
export const miniAppRectSchema = z.object({
  /*
   * `.finite()` is redundant on zod 4 — a bare `z.number()` already rejects
   * both NaN and Infinity, which it did not on zod 3. Stated anyway, because
   * the artifact rect states it and because "coordinates are finite" is a
   * property of this protocol rather than of whichever zod we happen to be on:
   * an infinite coordinate reaches `ElementPickOverlay` as `left: Infinity` and
   * draws the outline nowhere.
   */
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
})

export type MiniAppRect = z.infer<typeof miniAppRectSchema>

/**
 * A live text selection inside the app.
 *
 * Reported by the guest because a cross-origin host cannot read the frame's
 * selection — that isolation is the point, so the app volunteers it instead.
 */
export const miniAppSelectionSchema = z.object({
  // Clamped: a select-all in a long view otherwise dropped the whole
  // notification, so the "Ask about this" control never appeared — and, because
  // the clearing notification is the same message shape, a previous selection
  // could strand its control over text the user had moved off.
  text: clampedString(20_000, { min: 1 }),
  /** Absent when the app can't (or won't) report geometry; the host then falls
   *  back to its fixed chat affordance rather than floating a control. */
  rect: miniAppRectSchema.optional(),
})

export type MiniAppSelection = z.infer<typeof miniAppSelectionSchema>

/** `ui/notifications/selection-changed` — guest → host notification. Null clears the selection. */
export const selectionChangedNotificationSchema = envelopeSchema.extend({
  method: z.literal(miniAppGuestMethods.selectionChanged),
  params: z.object({ selection: miniAppSelectionSchema.nullable() }),
})

export type MiniAppSelectionChanged = z.infer<typeof selectionChangedNotificationSchema>

/**
 * `ui/request-auth-token` — guest → host request. No params.
 *
 * `jsonRpcIdSchema` like every other request, not `z.number()`. It was numeric
 * for a while, and because this is a discriminated union a guest whose JSON-RPC
 * library mints string ids uniformly — a perfectly ordinary choice, and one that
 * worked for its handshake and its `ui/open-chat` — had this one message fail
 * the parse and get dropped with no reply. Token refresh silently stopped, and a
 * frame that outlived its token had no way back.
 */
export const requestAuthTokenSchema = envelopeSchema.extend({
  id: jsonRpcIdSchema,
  method: z.literal(miniAppGuestMethods.requestAuthToken),
  params: z.object({}).default({}),
})

/**
 * Every message the host accepts from a guest. A discriminated union on `method`
 * so an unknown method fails parsing here rather than deeper in the bridge.
 */
export const miniAppGuestMessageSchema = z.discriminatedUnion('method', [
  requestAuthTokenSchema,
  initializeRequestSchema,
  contextUpdateNotificationSchema,
  chatOpenRequestSchema,
  selectionChangedNotificationSchema,
  runtimeErrorNotificationSchema,
])

export type MiniAppGuestMessage = z.infer<typeof miniAppGuestMessageSchema>
export type MiniAppInitializeRequest = z.infer<typeof initializeRequestSchema>
export type MiniAppContextUpdate = z.infer<typeof contextUpdateNotificationSchema>
export type MiniAppChatOpenRequest = z.infer<typeof chatOpenRequestSchema>
export type MiniAppRequestAuthToken = z.infer<typeof requestAuthTokenSchema>
export type MiniAppRuntimeError = z.infer<typeof runtimeErrorNotificationSchema>

/** Successful reply to a guest request. */
export type MiniAppHostResult = {
  jsonrpc: '2.0'
  protocol: typeof miniAppProtocolMarker
  id: string | number
  result: unknown
}

/** Error reply to a guest request. */
export type MiniAppHostError = {
  jsonrpc: '2.0'
  protocol: typeof miniAppProtocolMarker
  id: string | number
  error: { code: number; message: string }
}

/** Host → guest notification — no id, no reply expected. */
export type MiniAppHostNotification = {
  jsonrpc: '2.0'
  protocol: typeof miniAppProtocolMarker
  method: typeof miniAppHostMethods.hostContextChanged
  params: unknown
}

/**
 * Host → guest request — carries an id the guest must echo in its reply.
 *
 * Kept distinct from {@link MiniAppHostNotification} rather than folded into one
 * loose shape: a union member with every field optional would let a missing `id`
 * type-check as a request, and the guest would simply never reply.
 */
export type MiniAppHostRequest = {
  jsonrpc: '2.0'
  protocol: typeof miniAppProtocolMarker
  id: string | number
  method:
    | typeof miniAppHostMethods.elementAt
    | typeof miniAppHostMethods.toolsList
    | typeof miniAppHostMethods.toolsCall
  params: unknown
}

export type MiniAppHostMessage = MiniAppHostResult | MiniAppHostError | MiniAppHostNotification | MiniAppHostRequest

/**
 * One element the guest resolved a point down to.
 *
 * The guest **snaps** to whole meaningful elements rather than answering with
 * whatever leaf node happens to be under the cursor: pointing anywhere in a
 * table row should give the row, not the one `<td>` beneath the pixel. That
 * judgement has to live in the guest — only it knows what its own markup means
 * — which is why the host asks a question instead of doing geometry itself.
 */
export const miniAppSelectionItemSchema = z.object({
  /** Stable within one query; used as a React key and to de-duplicate. */
  id: clampedString(200, { min: 1 }),
  /** Short human label for the chip, e.g. "Q3 row". */
  label: clampedString(200, { min: 1 }),
  /** The content itself — what reaches the model. */
  text: clampedString(20_000, { min: 1 }),
  /** Optional structured payload for this item, forwarded uninterpreted. */
  data: z.unknown().optional(),
})

export type MiniAppSelectionItem = z.infer<typeof miniAppSelectionItemSchema>

/**
 * The guest's answer to `ui/element-at`.
 *
 * `rect` is in the guest's own viewport coordinates — what
 * `getBoundingClientRect()` returns inside the frame, already accounting for the
 * app's scroll — so the host can outline the element by offsetting against the
 * iframe's position. `null` means "nothing worth highlighting here", which is a
 * normal answer over padding or a background.
 */
export const elementAtResultSchema = z.object({
  element: miniAppSelectionItemSchema.extend({ rect: miniAppRectSchema }).nullable(),
})

export type MiniAppElementAtResult = z.infer<typeof elementAtResultSchema>
export type MiniAppHighlightedElement = NonNullable<MiniAppElementAtResult['element']>

/*
 * ─── Tools ───────────────────────────────────────────────────────────────────
 *
 * A Mini App can expose callable tools to the model, not just readable state.
 *
 * **Relationship to WebMCP.** WebMCP (`document.modelContext.registerTool`) is
 * the emerging browser-native answer to exactly this, and it explicitly covers
 * our topology: a parent discovers tools in a cross-origin child frame via
 * `allow="tools"` + `exposedTo`. We do not use it, for reasons that are about
 * where Thunderbolt runs rather than the design:
 *
 *   - **The desktop app can't.** Tauri embeds WKWebView on macOS and WebKitGTK
 *     on Linux. Neither implements WebMCP, and no config unlocks it. Only
 *     Windows (WebView2, Chromium) could. Desktop is a first-class surface here,
 *     so a Chromium-only tool layer would silently be a web-only feature.
 *   - **It isn't shipped.** Chrome runs a public origin trial (149→156); origin
 *     trials expire. It's a W3C Community Group draft, not standards-track, and
 *     the surface has already moved (`navigator.modelContext` →
 *     `document.modelContext`).
 *   - **Mozilla is neutral and Safari uncommitted.** For a Thunderbird product,
 *     resting an enterprise extension point on a Google/Microsoft API that our
 *     own engine has not committed to is a decision to take deliberately.
 *
 * So the descriptor below is **deliberately WebMCP-shaped**: `name`,
 * `description`, `inputSchema`, and an `annotations.readOnlyHint` that means what
 * it means there. Consequences we actually want:
 *
 *   1. An app that already implements WebMCP passes us the *same objects* it
 *      passes `registerTool` — adapting is a few lines, not a rewrite.
 *   2. If WebMCP ships broadly, the host feature-detects `document.modelContext`
 *      and prefers it, with this bridge as the fallback. An adapter, not a
 *      migration.
 *   3. The method names (`tools/list`, `tools/call`) are MCP's own, and this wire
 *      is already JSON-RPC 2.0 — so we sit closer to MCP than WebMCP does.
 *
 * The one place we knowingly diverge: MCP's `tools/call` returns an array of
 * content blocks. We return a single string, because every consumer downstream
 * (the AI SDK toolset) wants text. Widening later is additive.
 */

/**
 * Prompt budget for one tool's description. See {@link miniAppToolSchema}, and
 * {@link parseToolsList} for what happens when an app exceeds it.
 */
export const maxToolDescriptionChars = 300

/** Most tools one app can advertise. */
export const maxToolsPerApp = 64

/**
 * A tool the app exposes. Mirrors WebMCP's tool descriptor minus `execute`,
 * which stays inside the guest — the host only ever names a tool, never holds a
 * reference to its implementation.
 */
export const miniAppToolSchema = z.object({
  /** WebMCP's constraint, adopted verbatim so descriptors port unchanged. */
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  /*
   * Bounded tightly because this string reaches the *system* prompt, once per
   * tool, for the life of the turn's cached prefix. At 4 000 × 64 tools an app
   * could contribute a quarter of a megabyte of instructions sitting above our
   * own tool policy. A one-line description of what a tool does needs nothing
   * like that; the full schema travels separately in the tool definition.
   *
   * Over-long descriptions are truncated by {@link parseToolsList}, not
   * rejected — see the reasoning there.
   */
  description: z.string().min(1).max(maxToolDescriptionChars),
  /** JSON Schema for the arguments. Absent means the tool takes none. */
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z
    .object({
      /**
       * Deterministic and side-effect free. Read-only tools run silently;
       * anything else prompts the user before it touches the app. This is the
       * whole reason the flag is on the wire rather than inferred host-side —
       * only the app knows whether its own tool mutates something.
       */
      readOnlyHint: z.boolean().optional(),
      /** Human-facing label for the approval prompt. */
      title: clampedString(200).optional(),
    })
    .optional(),
})

export type MiniAppTool = z.infer<typeof miniAppToolSchema>

/**
 * Parse a `tools/list` reply, tolerating individual bad descriptors.
 *
 * Parsing the array strictly was a real bug: one tool whose description ran
 * over the cap failed the whole `tools` array, so the host discarded *every*
 * tool the app had — silently. The model simply had nothing to call, the app
 * looked inert, and nothing anywhere said why. An app author writing one
 * sentence too many is a formatting problem, not a reason to disable their app.
 *
 * So descriptions are **truncated** rather than rejected: the cap is our prompt
 * budget, not a correctness constraint, and a description cut short still tells
 * the model far more than no tool at all. Anything else invalid — a malformed
 * name, a description that is missing or empty — drops that one tool and is
 * reported to the caller, which logs it.
 *
 * {@link maxToolsPerApp} is sliced for the same reason. Capping the envelope on
 * it left the original bug intact one level up: an app advertising 65 tools
 * still lost all 65, and `dropped: 0` meant even the log stayed quiet.
 */
export const parseToolsList = (result: unknown): { tools: MiniAppTool[]; dropped: number } => {
  const envelope = z.object({ tools: z.array(z.unknown()) }).safeParse(result)
  if (!envelope.success) {
    return { tools: [], dropped: 0 }
  }

  const tools: MiniAppTool[] = []
  let dropped = Math.max(0, envelope.data.tools.length - maxToolsPerApp)
  for (const candidate of envelope.data.tools.slice(0, maxToolsPerApp)) {
    const truncated =
      candidate && typeof candidate === 'object' && typeof (candidate as MiniAppTool).description === 'string'
        ? { ...candidate, description: (candidate as MiniAppTool).description.slice(0, maxToolDescriptionChars) }
        : candidate
    const parsed = miniAppToolSchema.safeParse(truncated)
    if (parsed.success) {
      tools.push(parsed.data)
      continue
    }
    dropped += 1
  }
  return { tools, dropped }
}

/** Guest's answer to `tools/call`. */
export const toolsCallResultSchema = z.object({
  // Clamped, and this one lied to the model when it rejected: a tool returning a
  // large export ran, mutated the app, succeeded — and the host told the model
  // "did not return a usable result. It may have timed out," which invites a
  // retry of a mutation that already happened.
  content: clampedString(100_000),
  /** True when the tool failed; the host surfaces the content as an error. */
  isError: z.boolean().optional(),
})

export type MiniAppToolCallResult = z.infer<typeof toolsCallResultSchema>

/** Whether a tool needs user approval before it runs. */
export const requiresApproval = (tool: MiniAppTool): boolean => tool.annotations?.readOnlyHint !== true

/**
 * Envelope for a guest's reply to a host request — success or failure.
 *
 * JSON-RPC replies carry exactly one of `result` or `error`. Accepting only
 * `result` meant a guest that correctly reported a failure had its reply
 * dropped as unparseable, so the request sat unsettled until its timeout: an
 * app saying "that tool threw" was indistinguishable from an app saying
 * nothing, fifteen seconds later.
 */
const guestReplySchema = envelopeSchema.extend({
  id: jsonRpcIdSchema,
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number().int(),
      // Clamped, or this schema reopens the hole it was added to close: a guest
      // reporting a failure with a long stack trace would have its reply dropped
      // and the request would sit unsettled to its full timeout again.
      message: clampedString(2_000),
    })
    .optional(),
})

/** A guest's reported failure, already shaped for the caller to surface. */
export type MiniAppGuestError = { code: number; message: string }

/**
 * Parse an untrusted payload as a *reply* to a host request.
 *
 * Separate from {@link parseGuestMessage} because a JSON-RPC reply carries no
 * `method` to discriminate on. The caller still has to validate the `result`
 * against whatever it asked for — this only establishes "this is a reply, to
 * which request, and whether the guest is reporting a failure".
 */
export const parseGuestResult = (
  data: unknown,
): { id: string | number; result: unknown; error?: MiniAppGuestError } | null => {
  if (typeof data !== 'object' || data === null) {
    return null
  }
  if ((data as { protocol?: unknown }).protocol !== miniAppProtocolMarker) {
    return null
  }
  const record = data as Record<string, unknown>
  /*
   * A reply carries exactly one of `result` or `error`, and never `method`.
   * Both halves are load-bearing.
   *
   * `result` had been required, which discriminated replies from requests by
   * accident. Making it optional so a reported failure could be read (the
   * `error` form above) removed that accident, and a guest *request* with a
   * numeric id — `ui/request-auth-token`, `ui/open-chat` — began parsing as a
   * reply to a request the host never sent. The bridge checks for a reply
   * first, so those requests were swallowed and never dispatched: token refresh
   * silently stopped working, and a frame outliving its token had no way back.
   */
  if ('method' in record || (!('result' in record) && !('error' in record))) {
    return null
  }

  const parsed = guestReplySchema.safeParse(data)
  if (!parsed.success) {
    return null
  }
  return { id: parsed.data.id, result: parsed.data.result, error: parsed.data.error }
}

/**
 * A Thunderbolt-issued identity token, scoped to one app.
 *
 * The app validates `iss`, `aud`, signature and expiry, and MUST check `aud`
 * matches its own origin — a token minted for a different app is signed with a
 * different secret and should fail verification anyway, but checking the claim
 * is what makes that a deliberate property rather than a lucky one.
 */
export type MiniAppAuthToken = {
  /** Compact JWS. */
  token: string
  /** ISO 8601. Absolute rather than a duration, so no clock drift on the wire. */
  expiresAt: string
}

/** Result of a successful `initialize`. */
export type MiniAppInitializeResult = {
  protocolVersion: number
  hostName: string
  capabilities: MiniAppHostCapabilities
  hostContext: MiniAppHostContext
  /** Present when the guest declared the `auth` capability and minting worked. */
  auth?: MiniAppAuthToken
}

/** The host's current appearance, so the guest can match it. */
export type MiniAppTheme = 'light' | 'dark'

/**
 * Surface the frame is embedded in.
 *
 * An app that knows it's on a phone can drop to one column without guessing
 * from a viewport width, which is the difference between a layout that adapts
 * and one that merely shrinks.
 */
export type MiniAppPlatform = 'web' | 'desktop' | 'ios' | 'android'

/**
 * Ambient host state, handed over at `ui/initialize` and re-sent (partially)
 * whenever any of it changes.
 *
 * Grouped into one object rather than a notification per property because the
 * v1 shape — a theme-only message — was already the wrong shape the first time
 * a second property came along. `locale` is the immediate case: an app that
 * offers its own language toggle is re-asking a question the host already knows
 * the answer to.
 */
export type MiniAppHostContext = {
  theme: MiniAppTheme
  /**
   * BCP 47 tag, e.g. `de-DE`. The language the user chose in Thunderbolt, not
   * `navigator.language` — a German user reading a German UI should not get an
   * app formatting US currency beside it.
   */
  locale: string
  platform: MiniAppPlatform
}

/**
 * JSON-RPC error codes used by the bridge. Values match the JSON-RPC 2.0 spec's
 * reserved range so a generic client library reports them sensibly.
 */
export const miniAppRpcErrors = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  /** Guest asked for a wire version this host cannot speak. */
  unsupportedProtocolVersion: -32000,
  /**
   * No identity token could be issued — this deployment has no audience for the
   * app, or minting failed. Distinct from a transport error so a guest can stop
   * asking rather than retrying a request that will never succeed.
   */
  authUnavailable: -32001,
} as const

/**
 * Parse an untrusted `postMessage` payload into a guest message, or `null` when
 * it isn't one.
 *
 * This is only the *shape* half of validation — it deliberately knows nothing
 * about windows or origins. The caller must independently confirm the message
 * came from the expected frame and origin before acting on the result; see
 * `acceptGuestMessage` in `src/mini-apps/use-mini-app-bridge.ts`.
 */
export const parseGuestMessage = (data: unknown): MiniAppGuestMessage | null => {
  if (typeof data !== 'object' || data === null) {
    return null
  }
  // Check the marker before running zod: the message bus carries a lot of
  // unrelated traffic and a failed discriminated-union parse is far more
  // expensive than one property read.
  if ((data as { protocol?: unknown }).protocol !== miniAppProtocolMarker) {
    return null
  }
  const parsed = miniAppGuestMessageSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

/** Whether a guest's declared wire version is one this host can speak. */
export const isSupportedProtocolVersion = (version: number): boolean => version === miniAppProtocolVersion

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
 * to last. When app-exposed tools land (v1), they arrive as a new capability
 * flag — an app that doesn't declare it keeps working untouched.
 *
 * Trust model: the host never trusts the frame. Every inbound message is checked
 * for source window and origin by the host bridge, then parsed with the schemas
 * below. Anything that fails is dropped.
 */

import { z } from 'zod'

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
   * "What is inside this rectangle?" — sent when the user finishes dragging a
   * marquee over the app. The *interaction* is entirely the host's (it draws the
   * dim layer and the box over the frame); the guest only resolves geometry to
   * content, because only it can see its own DOM.
   */
  selectionQuery: 'ui/selection-query',
  /** Discover the tools the app exposes to the model. Sent once, after handshake. */
  toolsList: 'tools/list',
  /** Invoke one of them. */
  toolsCall: 'tools/call',
} as const

/**
 * What the guest declares it can do. Empty today — data-passing needs no
 * capabilities — but present from v1 of the wire so adding `tools` later is a
 * non-breaking change on both sides.
 */
export const miniAppGuestCapabilitiesSchema = z
  .object({
    /**
     * Reserved for v1: the app exposing callable tools to the model. Declared
     * here so the host can branch on it the day it exists without a version bump.
     */
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

/** What the host offers the guest, returned from `initialize`. */
export type MiniAppHostCapabilities = {
  /** The host will surface `ui/update-model-context` payloads to the model. */
  context: boolean
  /** The host honours `ui/open-chat`. */
  chat: boolean
  /**
   * The host can mint identity tokens for this app. False when the deployment
   * has no audience configured for it, so a guest can tell "not set up" apart
   * from "request failed" and say something useful instead of retrying.
   */
  auth: boolean
}

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
  title: z.string().max(200),
  /** Model-facing prose describing what the user is looking at. */
  summary: z.string().max(20_000),
  /** Arbitrary app-defined state. Never interpreted by the host. */
  data: z.unknown().optional(),
  /** What is focused/selected right now, when the app has a notion of it. */
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
    /** Display name the app reports for itself; host chrome may show it. */
    appName: z.string().max(200).optional(),
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
    // should not be able to hand us an unbounded string to hold.
    message: z.string().min(1).max(500),
  }),
})

/** `ui/open-chat` — guest → host request. */
export const chatOpenRequestSchema = envelopeSchema.extend({
  id: jsonRpcIdSchema,
  method: z.literal(miniAppGuestMethods.chatOpen),
  params: z
    .object({
      /** Seed the composer with this text (not auto-sent). */
      prompt: z.string().max(10_000).optional(),
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
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

export type MiniAppRect = z.infer<typeof miniAppRectSchema>

/**
 * A live text selection inside the app.
 *
 * Reported by the guest because a cross-origin host cannot read the frame's
 * selection — that isolation is the point, so the app volunteers it instead.
 */
export const miniAppSelectionSchema = z.object({
  text: z.string().min(1).max(20_000),
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
 * Every message the host accepts from a guest. A discriminated union on `method`
 * so an unknown method fails parsing here rather than deeper in the bridge.
 */
/** `ui/request-auth-token` — guest → host request. No params. */
export const requestAuthTokenSchema = envelopeSchema.extend({
  id: z.number(),
  method: z.literal(miniAppGuestMethods.requestAuthToken),
  params: z.object({}).default({}),
})

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
    | typeof miniAppHostMethods.selectionQuery
    | typeof miniAppHostMethods.toolsList
    | typeof miniAppHostMethods.toolsCall
  params: unknown
}

export type MiniAppHostMessage = MiniAppHostResult | MiniAppHostError | MiniAppHostNotification | MiniAppHostRequest

/**
 * One thing the guest resolved a marquee down to.
 *
 * The guest **snaps** to whole elements rather than returning whatever text the
 * rectangle happened to clip: dragging roughly around two table rows should yield
 * two rows, not two half-sentences. That judgement has to live in the guest —
 * only it knows what its own markup means — which is why the host asks a question
 * instead of doing geometry itself.
 */
export const miniAppSelectionItemSchema = z.object({
  /** Stable within one query; used as a React key and to de-duplicate. */
  id: z.string().min(1).max(200),
  /** Short human label for the chip, e.g. "Q3 row". */
  label: z.string().min(1).max(200),
  /** The content itself — what reaches the model. */
  text: z.string().min(1).max(20_000),
  /** Optional structured payload for this item, forwarded uninterpreted. */
  data: z.unknown().optional(),
})

export type MiniAppSelectionItem = z.infer<typeof miniAppSelectionItemSchema>

/**
 * Guest's answer to `ui/selection-query`. Capped so a pathological app (or a drag
 * across the whole page) can't flood the composer with chips.
 */
export const selectionQueryResultSchema = z.object({
  items: z.array(miniAppSelectionItemSchema).max(50),
})

export type MiniAppSelectionQueryResult = z.infer<typeof selectionQueryResultSchema>

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
  description: z.string().min(1).max(4_000),
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
      title: z.string().max(200).optional(),
    })
    .optional(),
})

export type MiniAppTool = z.infer<typeof miniAppToolSchema>

/** Guest's answer to `tools/list`. */
export const toolsListResultSchema = z.object({
  tools: z.array(miniAppToolSchema).max(64),
})

/** Guest's answer to `tools/call`. */
export const toolsCallResultSchema = z.object({
  content: z.string().max(100_000),
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
      message: z.string().max(2_000),
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
 * a second property came along. `locale` is the immediate case: Patient
 * Journeys ships an EN/DE toggle it currently has to render itself, when the
 * host already knows the answer.
 */
export type MiniAppHostContext = {
  theme: MiniAppTheme
  /**
   * BCP 47 tag, e.g. `de-DE`. Sourced from the browser today; move this to the
   * account's language setting once the i18n layer lands (THU-812).
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

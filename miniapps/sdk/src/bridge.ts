/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Thunderbolt Mini App bridge — guest side.
 *
 * Drop this file into any web app you want to embed in Thunderbolt. It has no
 * dependencies and knows nothing about React, so the same file works in Vue,
 * Svelte, or plain JS. The React binding lives in `use-thunderbolt.ts` next to
 * it and is a thin wrapper over this.
 *
 * Wire format is JSON-RPC 2.0 over `postMessage`, stamped with a
 * `protocol: 'thunderbolt-miniapp'` marker so neither side has to sift through
 * unrelated traffic on the message bus.
 *
 * Lifecycle:
 *   1. `connect()` posts `initialize` to the parent and waits for the reply.
 *   2. The host asks for context with `ui/get-context` whenever the model needs
 *      it, and your `getContext` answers with the *current* view.
 *   3. Call `openChat()` to ask Thunderbolt to open its chat panel.
 *
 * The host never trusts us and we never trust the host: every inbound message is
 * checked against the origin we were told to expect.
 */

import { elementAtPoint, type HighlightedElement } from './selection-hit-test'
import {
  descriptorSignature,
  flattenToolResult,
  installModelContext,
  textResult,
  toDescriptor,
  type ModelContextTool,
  type ModelContextToolResult,
} from './model-context'
import { toModelContextTool, type ThunderboltTool } from './tools'

/** Exported for the tests; not re-exported from `index.ts`, so not public API. */
export const protocolMarker = 'thunderbolt-miniapp'
/**
 * The wire version we declare at handshake.
 *
 * Must be a member of the host's `supportedProtocolVersions`
 * (`shared/mini-app-protocol.ts`) or the handshake is rejected outright — which
 * is exactly what a bump on one side alone causes, and it is silent in tests
 * that build the handshake from the host's own constant. `protocol-version.test.ts`
 * beside the host reads both literals off disk to keep them honest.
 */
const protocolVersion = 3

/**
 * An id for *this document*, minted once and kept for as long as it lives.
 *
 * Module state, which is per-document by construction: navigating re-evaluates
 * the module and the next page gets a different id. That is the whole property
 * the host needs — it cannot tell the frame's documents apart on its own,
 * because a cross-origin `load` event carries no identity.
 *
 * Lazy rather than eagerly assigned, so importing this module during SSR
 * neither needs `crypto` nor mints an id nobody will send.
 */
let documentIdValue: string | null = null

const documentId = (): string => (documentIdValue ??= crypto.randomUUID())

export type MiniAppContext = {
  /** Short label for the current view. */
  title: string
  /** Prose written for a language model to read. This is what it reasons over. */
  summary: string
  /** Arbitrary structured state. Thunderbolt forwards it without interpreting it. */
  data?: unknown
  /** Whatever is focused right now, if the app has a notion of selection. */
  selection?: unknown
}

export type Theme = 'light' | 'dark'

/** Surface the app is embedded in. Lets a layout adapt rather than just shrink. */
export type Platform = 'web' | 'desktop' | 'ios' | 'android'

/** A Thunderbolt-issued identity token, scoped to this app. */
export type AuthToken = {
  /** Compact JWS. Send it to *your* backend; verify it there. */
  token: string
  /** ISO 8601. */
  expiresAt: string
}

/**
 * Ambient host state. Delivered whole at connect, then partially whenever a
 * piece of it changes — so treat an update as a patch, not a replacement.
 */
export type HostContext = {
  theme: Theme
  /** BCP 47, e.g. `de-DE`. Use it instead of shipping your own language picker. */
  locale: string
  platform: Platform
}

export type ConnectOptions = {
  /** Name reported to the host during the handshake. */
  appName: string
  /**
   * Origin of the embedding Thunderbolt instance. Inbound messages from anywhere
   * else are ignored. Defaults to the dev server (port 1420, a Tauri convention
   * rather than Vite's usual 5173); set it explicitly in production.
   */
  hostOrigin?: string
  /**
   * Called on connect with the full host context, then again with a patch each
   * time part of it changes. Merge rather than overwrite.
   */
  onHostContextChange?: (patch: Partial<HostContext>) => void
  /**
   * What the user is looking at, right now.
   *
   * Called on every `get_app_context`, so it must read your live state rather
   * than a snapshot taken earlier — that is the whole point. Return `null` while
   * you have nothing to report (still loading, say); the host tells the model it
   * could not read the screen, which is better than a stale answer presented as
   * current.
   *
   * Keep it cheap. It sits on the model's critical path and the host gives up
   * after a couple of seconds.
   *
   * This replaces `sendContext()`, which pushed to a host-side cache and put the
   * burden on you to re-publish on every meaningful change — miss one and the
   * assistant confidently described a screen the user had left.
   */
  getContext?: () => MiniAppContext | null
  /**
   * Report text selections to the host, so it can float an "Ask about this"
   * control over highlighted text. On by default — the app gets the feature
   * without writing any code for it. Set false for an app that manages its own
   * selection UI and would collide.
   */
  watchSelection?: boolean
  /**
   * Resolve a marquee rectangle to the things inside it, for the host's Select
   * tool. Defaults to a generic DOM hit-test that works on any markup — override
   * when your app can give a cleaner, more semantic answer (returning domain
   * objects rather than scraped text).
   */
  resolveElementAt?: (point: { x: number; y: number }) => HighlightedElement | null
  /**
   * Tools the assistant can call in your app.
   *
   * A convenience over `document.modelContext.registerTool()`, which is the
   * canonical way and which this SDK makes available in every browser (see
   * `model-context.ts`). Both end up in the same registry; this one exists
   * because a React `execute` closes over current state, so the array is
   * rebuilt every render and resolved per call — where the equivalent
   * `registerTool` is an effect that re-registers on every keystroke.
   *
   * Re-read on every `tools/list` and every `tools/call`, so a getter whose
   * answer changes as data loads is fine.
   */
  tools?: ThunderboltTool[] | (() => ThunderboltTool[])
  /**
   * Ask Thunderbolt who the user is.
   *
   * Off by default: an app that doesn't need identity shouldn't cause a token to
   * be minted. Turn it on and `getAuthToken()` starts returning a JWT whose
   * `aud` is this app's origin, signed with the secret you were issued at
   * deploy time.
   */
  auth?: boolean
}

export type Connection = {
  /** Ask the host to open its chat panel, optionally seeding the composer. */
  openChat: (prompt?: string) => void
  /**
   * Re-read the `tools` option and tell the host if it moved.
   *
   * Needed because the option is resolved lazily and nothing observes it. An
   * app whose tools appear once data loads — `tools: () => loaded ? [...] : []`,
   * which is the normal shape — declared no `tools` capability at connect, so
   * the host never asked, and no registry change ever fired to make it ask.
   * The tools existed and the model could not see them.
   *
   * `useThunderbolt` calls this for you when your array changes. Call it
   * yourself only if you are using `connect()` directly *and* passing a getter;
   * `document.modelContext.registerTool()` announces itself.
   *
   * Idempotent — a call that finds nothing changed sends nothing.
   */
  syncTools: () => Promise<void>
  /** Host context at connect time. */
  hostContext: HostContext
  /**
   * A currently-valid identity token, or null when the host can't issue one.
   *
   * Refreshes itself when the current token is close to expiring, so call it
   * before each request to your backend rather than caching the result. A frame
   * can sit open for hours; a token you held onto cannot.
   */
  getAuthToken: () => Promise<AuthToken | null>
  /**
   * Tell the host something went wrong in here.
   *
   * Uncaught errors and unhandled rejections are forwarded automatically once
   * connected; this is for failures you catch yourself and still want surfaced
   * — a fetch that came back 500, a parse that failed. The host shows it as a
   * strip over the frame and truncates at 500 characters.
   */
  reportError: (message: string) => void
  /** Remove listeners. */
  disconnect: () => void
}

type PendingResolver = (result: unknown) => void

/** One in-flight guest request: how to settle it, and the deadline that will. */
type PendingRequest = { settle: PendingResolver; timer: ReturnType<typeof setTimeout> }

/**
 * Longest an ordinary request waits for the host.
 *
 * Requests used to have no deadline at all and `disconnect()` left `pending`
 * untouched, so a token request made just before the host stopped answering —
 * or just before the component unmounted — stayed pending forever, and the
 * caller's `await` never returned. Settling as a failure rather than rejecting
 * keeps the existing shape: every caller already handles an `{ error }` reply,
 * because that is what the host sends when a request genuinely fails.
 */
const requestTimeoutMs = 10_000

/**
 * Debounce for selection reporting. `selectionchange` fires per character while
 * dragging, and the host repositions a floating control on every message — this
 * waits for the selection to settle instead.
 */
const selectionDebounceMs = 180

/**
 * Read the current selection as the host wants it: the text plus where it sits
 * in *this frame's* viewport. Returns null for a collapsed or empty selection,
 * which the host reads as "dismiss the control".
 */
const readSelection = (): {
  text: string
  rect?: { x: number; y: number; width: number; height: number }
} | null => {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null
  }
  const text = selection.toString().trim()
  if (text.length === 0) {
    return null
  }
  const bounds = selection.getRangeAt(0).getBoundingClientRect()
  // A zero-area rect means the range isn't laid out (e.g. inside a hidden
  // element); send the text without geometry rather than pinning a control to 0,0.
  const rect =
    bounds.width > 0 || bounds.height > 0
      ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      : undefined
  return { text, rect }
}

/** Identity claims Thunderbolt puts in the token. */
export type TokenClaims = {
  sub: string
  email: string
  name: string
  aud: string
  iss: string
  exp: number
}

/**
 * Read the claims out of a token **without verifying it.**
 *
 * Fine for putting a name in the corner of your UI. Never fine for deciding
 * what someone is allowed to do — anyone can hand your page a JWT that says
 * whatever they like, and this function will happily read it back.
 *
 * Real verification needs the signing secret you were issued at deploy time,
 * which belongs on your server, not in a bundle every user can read. Send the
 * token to your backend and verify it there.
 */
export const readTokenClaims = (token: string): TokenClaims | null => {
  const payload = token.split('.')[1]
  if (!payload) {
    return null
  }
  try {
    /*
     * Decoded as UTF-8, not as a Latin-1 "binary string".
     *
     * `atob` yields one char per *byte*, but a JWT payload is base64url over
     * UTF-8 — so a name like "Müller" came back mojibake'd. It failed silently
     * too: the mangled bytes are still valid JSON, so nothing threw and the
     * garbled name went straight into the UI, which is the one use this function
     * documents itself as being for.
     */
    const bytes = Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as TokenClaims
  } catch {
    return null
  }
}

/**
 * Why `connect` rejected, when the reason is "nobody is framing us".
 *
 * A distinct type because that outcome is a *supported mode* and every other
 * rejection is a fault. They were indistinguishable — a bare `catch` treating
 * all of them as standalone swallowed a refused handshake, an unsupported
 * protocol version, a handshake timeout and any implementation error alike, so
 * the host eventually showed a generic unreachable panel and the actionable
 * cause was gone.
 */
export class NotEmbeddedError extends Error {
  constructor() {
    super('not embedded: window.parent === window')
    this.name = 'NotEmbeddedError'
  }
}

/** Are we actually inside a frame? Running standalone is legal — just not embedded. */
export const isEmbedded = (): boolean => typeof window !== 'undefined' && window.parent !== window

/**
 * Connect to the Thunderbolt host.
 *
 * Resolves once the host answers `initialize`, or rejects after `timeoutMs` —
 * which is the normal outcome when the app is opened directly in a browser tab
 * rather than embedded, so callers should treat rejection as "run standalone",
 * not as an error.
 */
export const connect = (options: ConnectOptions, timeoutMs = 5_000): Promise<Connection> => {
  const {
    appName,
    hostOrigin = 'http://localhost:1420',
    onHostContextChange,
    watchSelection = true,
    resolveElementAt = (point: { x: number; y: number }) => elementAtPoint(point),
    getContext,
    tools = [],
    auth = false,
  } = options

  // Resolved per call, not captured once. A React app almost always redefines its
  // tool array every render (the `execute` closures need current state), so a
  // snapshot taken at connect time would invoke against state frozen at mount.
  const resolveTools = (): ThunderboltTool[] => (typeof tools === 'function' ? tools() : tools)

  /*
   * Native WebMCP where the browser has it, our shim otherwise — and either way
   * the single place tools live. Taken here rather than in the executor below so
   * the registry exists whether or not the handshake ever succeeds: an app that
   * calls `registerTool` outside a Thunderbolt frame is registering with the
   * browser, which is none of our business to gate.
   */
  const { modelContext } = installModelContext()

  return new Promise<Connection>((resolve, reject) => {
    if (!isEmbedded()) {
      reject(new NotEmbeddedError())
      return
    }

    let nextId = 1
    const pending = new Map<number, PendingRequest>()

    /** Settle one request once, clearing its deadline. Safe to call twice. */
    const settlePending = (id: number, result: unknown) => {
      const entry = pending.get(id)
      if (!entry) {
        return
      }
      clearTimeout(entry.timer)
      pending.delete(id)
      entry.settle(result)
    }

    const post = (payload: Record<string, unknown>) => {
      // Targeted origin, never '*' — a wildcard would broadcast app state to
      // whatever page happens to be framing us.
      window.parent.postMessage({ jsonrpc: '2.0', protocol: protocolMarker, ...payload }, hostOrigin)
    }

    const request = (method: string, params: unknown, deadlineMs = requestTimeoutMs): Promise<unknown> => {
      const id = nextId++
      return new Promise((resolveRequest) => {
        const timer = setTimeout(
          () =>
            settlePending(id, { error: { message: `Thunderbolt did not answer ${method} within ${deadlineMs}ms` } }),
          deadlineMs,
        )
        pending.set(id, { settle: resolveRequest, timer })
        post({ id, method, params })
      })
    }

    const notify = (method: string, params: unknown) => post({ method, params })

    /**
     * Tell the host its tool list is out of date, so it re-runs `tools/list`.
     *
     * This is what makes `registerTool` usable at all: the host asks for tools
     * once, right after the handshake, and the canonical way to register is a
     * call in an effect — which runs *after* it. Without a nudge the tool would
     * exist in the page and be invisible to the model, with nothing to indicate
     * why.
     *
     * Queued until connected, because registration is allowed to happen before
     * `connect()` — the shim installs at import precisely so it can. And skipped
     * while we are mirroring the `tools` option, which would otherwise announce
     * a change the host is in the middle of asking about.
     */
    let connected = false
    let mirroring = false
    let announcementPending = false

    const announceToolChange = () => {
      if (mirroring) {
        return
      }
      if (!connected) {
        announcementPending = true
        return
      }
      notify('ui/notifications/tools-changed', {})
    }

    modelContext.addEventListener('toolchange', announceToolChange)

    /**
     * Mirror the `tools` option into the registry.
     *
     * Diffed by name against what is already there, and **idempotent** — which
     * is what stops the loop: a mirrored registration fires `toolchange`, the
     * notification below makes the host re-list, answering that re-syncs, and a
     * sync that changes nothing emits nothing.
     *
     * The registered `execute` re-resolves by name instead of closing over the
     * tool it was registered from. A React app redefines its tool array every
     * render so the closures see current state, and a descriptor captured at
     * connect would invoke against state frozen at mount. Only the *metadata*
     * is snapshotted, and a change to that re-registers.
     */
    const mirrored = new Map<string, { descriptor: string; controller: AbortController }>()

    const mirroredTool = (snapshot: ThunderboltTool): ModelContextTool => ({
      ...toDescriptor(toModelContextTool(snapshot)),
      execute: async (args) => {
        const current = resolveTools().find((candidate) => candidate.name === snapshot.name)
        if (!current) {
          return textResult(`No tool named "${snapshot.name}" is registered.`, true)
        }
        // Caught here rather than left to the registry: native WebMCP owns
        // `executeTool` when it is present, and how it treats a throwing
        // `execute` is its business. An error the model can read about is ours.
        try {
          return await toModelContextTool(current).execute(args as never)
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error), true)
        }
      },
    })

    /**
     * Mirror the option into the registry.
     *
     * `announce` is false when the host asked for the list itself — it is
     * already mid-question, and announcing would have it ask again. True when
     * the app's own tool array changed, which is the only signal the host has
     * that an option resolved later than connect finally has something in it.
     */
    const syncOptionTools = async ({ announce }: { announce: boolean }): Promise<void> => {
      mirroring = !announce
      try {
        await mirrorOptionTools()
      } finally {
        mirroring = false
      }
    }

    const mirrorOptionTools = async (): Promise<void> => {
      const current = resolveTools()
      for (const tool of current) {
        // Never a bare `JSON.stringify`: an unserialisable `inputSchema` threw
        // out of this loop, past the per-tool guard below, and cost the app
        // every one of its *other* tools for that list. The guard then rejects
        // the descriptor on its own account, which is the outcome we want —
        // the host would drop it too, so it could never reach the model.
        const descriptor = descriptorSignature(tool) ?? `<unserialisable:${tool.name}>`
        const previous = mirrored.get(tool.name)
        if (previous?.descriptor === descriptor) {
          continue
        }
        previous?.controller.abort()
        const controller = new AbortController()
        /*
         * Per tool, because `registerTool` rejects a descriptor the host would
         * drop — and one bad name used to cost the whole sync. The rejection
         * escaped into `answerToolsList`, which then never posted, so the host
         * waited out its deadline and lost every *valid* tool too. Reported and
         * skipped instead, and left out of `mirrored` so a corrected descriptor
         * is retried rather than remembered as broken.
         */
        try {
          await modelContext.registerTool(mirroredTool(tool), { signal: controller.signal })
          mirrored.set(tool.name, { descriptor, controller })
        } catch (error) {
          mirrored.delete(tool.name)
          reportError(`tool "${tool.name}" was rejected: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const names = new Set(current.map((tool) => tool.name))
      for (const [name, entry] of [...mirrored]) {
        if (!names.has(name)) {
          entry.controller.abort()
          mirrored.delete(name)
        }
      }
    }

    /**
     * Answer `tools/list` out of the registry, option tools included.
     *
     * Never leaves the request unanswered. The host correlates by id and waits
     * out its deadline otherwise, so a throw anywhere in here would read to it
     * as "this app does not implement tools" — and cost the model every tool
     * the app does have, for the whole connection.
     */
    const answerToolsList = async (requestId: unknown): Promise<void> => {
      try {
        await syncOptionTools({ announce: false })
        post({ id: requestId, result: { tools: (await modelContext.getTools()).map(toDescriptor) } })
      } catch (error) {
        reportError(`tools/list failed: ${error instanceof Error ? error.message : String(error)}`)
        post({ id: requestId, result: { tools: [] } })
      }
    }

    /**
     * Run one host-requested tool and answer on the same request id.
     *
     * Dispatched through `executeTool` rather than by reaching for the
     * descriptor's own `execute`: that is the spec's accessor, so when native
     * WebMCP is present the call goes through the browser's own plumbing — and
     * `getTools()` is not obliged to hand back a callable at all.
     */
    const answerToolCall = async (requestId: unknown, name: string, args: unknown): Promise<void> => {
      const result = await (async (): Promise<ModelContextToolResult> => {
        // Same contract as `answerToolsList`: an unanswered call blocks a model
        // turn for the full deadline, and the model is told nothing it can use.
        try {
          await syncOptionTools({ announce: false })
          const tool = (await modelContext.getTools()).find((candidate) => candidate.name === name)
          return tool
            ? await modelContext.executeTool(tool, args)
            : textResult(`No tool named "${name}" is registered.`, true)
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error), true)
        }
      })()
      post({ id: requestId, result: flattenToolResult(result) })
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== hostOrigin || event.source !== window.parent) {
        return
      }
      const data = event.data as
        | {
            protocol?: string
            id?: number
            result?: unknown
            error?: unknown
            method?: string
            params?: unknown
          }
        | undefined
      if (!data || data.protocol !== protocolMarker) {
        return
      }

      // A request from the host: has an id *and* a method, and expects a reply.
      // Checked before the reply path, which keys only on id.
      if (typeof data.id === 'number' && typeof data.method === 'string') {
        if (data.method === 'ui/element-at') {
          const point = data.params as { x?: number; y?: number } | undefined
          // Reply even when we can't answer — the host times out otherwise, and a
          // silent timeout looks identical to a broken app.
          const element =
            typeof point?.x === 'number' && typeof point?.y === 'number'
              ? resolveElementAt({ x: point.x, y: point.y })
              : null
          post({ id: data.id, result: { element } })
          return
        }
        if (data.method === 'ui/get-context') {
          /*
           * Answered even when we have nothing, and never allowed to throw.
           *
           * The host cannot tell a thrown `getContext` from a frame that went
           * away — both are silence, and silence costs the model the full
           * deadline. Replying `null` says "nothing to report" in one round
           * trip, which the host renders as "couldn't read the screen".
           */
          let context: MiniAppContext | null = null
          try {
            context = getContext?.() ?? null
          } catch (error) {
            reportError(`getContext threw: ${error instanceof Error ? error.message : String(error)}`)
          }
          post({ id: data.id, result: { context } })
          return
        }
        if (data.method === 'ui/identify') {
          /*
           * "Yes, and I am this document." The host asks after every frame
           * `load` to find out whether the handshake it holds belongs to the
           * page now in the frame. Answering at all is most of the signal — a
           * document whose `connect()` has not run yet cannot reply, and that
           * silence is what tells the host to reset and wait.
           */
          post({ id: data.id, result: { documentId: documentId() } })
          return
        }
        if (data.method === 'tools/list') {
          // Voided for the same reason as `tools/call` below.
          void answerToolsList(data.id)
          return
        }
        if (data.method === 'tools/call') {
          const params = data.params as { name?: string; arguments?: unknown } | undefined
          const requestId = data.id
          // Voided rather than awaited: a `message` listener cannot be async
          // without turning a rejection into an unhandled one, and the host
          // correlates the answer by id anyway, so nothing here needs ordering.
          void answerToolCall(requestId, params?.name ?? '', params?.arguments)
          return
        }
        return
      }

      if (typeof data.id === 'number') {
        settlePending(data.id, data.error ? { error: data.error } : data.result)
        return
      }

      if (data.method === 'ui/notifications/host-context-changed') {
        // Partial by contract: the host sends only what moved.
        onHostContextChange?.((data.params ?? {}) as Partial<HostContext>)
      }
    }

    window.addEventListener('message', handleMessage)

    let teardownSelection: (() => void) | null = null
    let teardownErrors: (() => void) | null = null

    const disconnect = () => {
      window.removeEventListener('message', handleMessage)
      modelContext.removeEventListener('toolchange', announceToolChange)
      /*
       * Unregister what this connection mirrored. `document.modelContext`
       * outlives the connection — it is the document's, and reconnecting in the
       * same page is ordinary (React StrictMode, a remount) — so leaving these
       * behind left the host listing tools from a bridge that had gone away,
       * whose `execute` still closed over the old connection's `resolveTools`.
       * A tool the new connection does not have could still be called.
       *
       * Only ours: anything the app registered directly is the app's to manage
       * through its own `AbortSignal`, and still belongs to a live document.
       */
      for (const entry of mirrored.values()) {
        entry.controller.abort()
      }
      mirrored.clear()
      teardownSelection?.()
      teardownSelection = null
      teardownErrors?.()
      teardownErrors = null
      /*
       * Settle whatever was in flight. The listener is gone, so nothing will
       * ever answer these — leaving them in the map left the caller's `await`
       * hanging for the life of the page, which is how an unmounted component's
       * pending token request became a permanent leak.
       */
      for (const id of [...pending.keys()]) {
        settlePending(id, { error: { message: 'Disconnected from Thunderbolt before the request was answered' } })
      }
    }

    /**
     * Forward a failure to the host, bounded to what it will accept.
     *
     * Thunderbolt cannot see inside a cross-origin frame, so an app that throws
     * is invisible to it: the panel looks fine and the user has no idea why the
     * numbers stopped moving. Artifacts report this for free because the host
     * writes their harness; an app has to volunteer it.
     */
    const reportError = (message: string) => {
      notify('ui/notifications/error', { message: message.slice(0, 500) })
    }

    /** Report uncaught errors and unhandled rejections until disconnected. */
    const startWatchingErrors = () => {
      const onError = (event: ErrorEvent) => reportError(event.message || 'Unknown error')
      const onRejection = (event: PromiseRejectionEvent) => reportError(`Unhandled rejection: ${String(event.reason)}`)

      window.addEventListener('error', onError)
      window.addEventListener('unhandledrejection', onRejection)
      return () => {
        window.removeEventListener('error', onError)
        window.removeEventListener('unhandledrejection', onRejection)
      }
    }

    /** Report selections until disconnected. */
    const startWatchingSelection = () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let lastSent: string | null = null

      const report = () => {
        const current = readSelection()
        // Deselecting must still be sent once (to dismiss the host control), but
        // repeated nulls while the user clicks around are noise.
        const key = current ? `${current.text}@${current.rect?.x ?? 'n'},${current.rect?.y ?? 'n'}` : null
        if (key === lastSent) {
          return
        }
        lastSent = key
        notify('ui/notifications/selection-changed', { selection: current })
      }

      const onSelectionChange = () => {
        clearTimeout(timer)
        timer = setTimeout(report, selectionDebounceMs)
      }

      document.addEventListener('selectionchange', onSelectionChange)
      // Scrolling moves the selection under a control that's already placed, so
      // re-report geometry rather than leaving it stranded.
      window.addEventListener('scroll', onSelectionChange, {
        passive: true,
        capture: true,
      })

      teardownSelection = () => {
        clearTimeout(timer)
        document.removeEventListener('selectionchange', onSelectionChange)
        window.removeEventListener('scroll', onSelectionChange, {
          capture: true,
        })
      }
    }

    const timer = setTimeout(() => {
      disconnect()
      reject(new Error(`Thunderbolt did not respond to initialize within ${timeoutMs}ms`))
    }, timeoutMs)

    /*
     * Read before the handshake, not during it: this decides whether the host
     * asks for a tool list unprompted, and `ui/notifications/tools-changed`
     * covers everything registered after. A getter that returns tools only once
     * some data has loaded is therefore not a problem — it announces later.
     */
    const declaredTools = resolveTools().length > 0

    // The one `.then` in this file, and deliberate: it sits inside a Promise
    // executor, which cannot be async — returning a promise from one is an
    // anti-pattern, and the timeout above has to be able to reject. Rewriting
    // it as async/await would mean restructuring the deadline race for no gain.
    void request(
      'ui/initialize',
      {
        protocolVersion,
        appName,
        documentId: documentId(),
        // Declared, not assumed: the host only asks for a tool list when we say we
        // have one, so an app with no tools costs no request and no timeout.
        capabilities: {
          // Declared, so the host can say "this app reports no state" instead of
          // waiting out a deadline on every `get_app_context`.
          context: getContext !== undefined,
          selection: watchSelection,
          tools: declaredTools,
          auth,
        },
      },
      // One deadline for the handshake, not two racing: `connect`'s own timeout
      // owns it, and the per-request default would only fire after it.
      timeoutMs,
    ).then((result) => {
      clearTimeout(timer)
      const typed = result as
        | {
            hostContext?: HostContext
            auth?: AuthToken
            error?: { message?: string }
          }
        | undefined
      if (typed?.error) {
        disconnect()
        reject(new Error(typed.error.message ?? 'handshake rejected'))
        return
      }
      // Defaults keep a standalone or older host from leaving the app unstyled.
      const hostContext: HostContext = {
        theme: 'light',
        locale: 'en',
        platform: 'web',
        ...(typed?.hostContext ?? {}),
      }
      onHostContextChange?.(hostContext)
      if (watchSelection) {
        startWatchingSelection()
      }
      teardownErrors = startWatchingErrors()
      connected = true
      /*
       * Catch up on anything registered before the handshake landed. Two ways
       * that happens and only one of them queued an announcement: a `registerTool`
       * during `connect()` fired a `toolchange` we heard and deferred, while one
       * *before* `connect()` fired it into a registry nobody was listening to —
       * so the registry itself is the second source of truth. Skipped entirely
       * when we declared the capability, because then the host is already asking.
       */
      void (async () => {
        const hadRegistrations = announcementPending || (await modelContext.getTools()).length > 0
        announcementPending = false
        if (!declaredTools && hadRegistrations) {
          announceToolChange()
        }
      })()
      // Refresh slightly early: a token that expires while a request is in
      // flight fails at the far end, where the error is least legible.
      const refreshSkewMs = 30_000
      let currentToken: AuthToken | null = typed?.auth ?? null

      const getAuthToken = async (): Promise<AuthToken | null> => {
        if (currentToken && Date.parse(currentToken.expiresAt) - Date.now() > refreshSkewMs) {
          return currentToken
        }
        const next = (await request('ui/request-auth-token', {})) as
          { token?: string; expiresAt?: string; error?: unknown } | undefined
        currentToken = next?.token && next?.expiresAt ? { token: next.token, expiresAt: next.expiresAt } : null
        return currentToken
      }

      resolve({
        getAuthToken,
        syncTools: () => syncOptionTools({ announce: true }),
        openChat: (prompt) => void request('ui/open-chat', prompt ? { prompt } : {}),
        reportError,
        hostContext,
        disconnect,
      })
    })
  })
}

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
 *   2. Once connected, call `sendContext()` whenever the user's view changes.
 *   3. Call `openChat()` to ask Thunderbolt to open its chat panel.
 *
 * The host never trusts us and we never trust the host: every inbound message is
 * checked against the origin we were told to expect.
 */

import { elementAtPoint, type HighlightedElement } from './selection-hit-test'
import { callTool, toDescriptors, type ThunderboltTool } from './tools'

const protocolMarker = 'thunderbolt-miniapp'
const protocolVersion = 2

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
   * Tools the assistant can call in your app. See `thunderbolt-tools.ts` — the
   * descriptors are WebMCP-shaped, so the same objects work with
   * `document.modelContext.registerTool` where that exists.
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
  /** Publish what the user is looking at. Call on every meaningful change. */
  sendContext: (context: MiniAppContext) => void
  /** Ask the host to open its chat panel, optionally seeding the composer. */
  openChat: (prompt?: string) => void
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
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json) as TokenClaims
  } catch {
    return null
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
    tools = [],
    auth = false,
  } = options

  // Resolved per call, not captured once. A React app almost always redefines its
  // tool array every render (the `execute` closures need current state), so a
  // snapshot taken at connect time would invoke against state frozen at mount.
  const resolveTools = (): ThunderboltTool[] => (typeof tools === 'function' ? tools() : tools)

  return new Promise<Connection>((resolve, reject) => {
    if (!isEmbedded()) {
      reject(new Error('not embedded: window.parent === window'))
      return
    }

    let nextId = 1
    const pending = new Map<number, PendingResolver>()

    const post = (payload: Record<string, unknown>) => {
      // Targeted origin, never '*' — a wildcard would broadcast app state to
      // whatever page happens to be framing us.
      window.parent.postMessage({ jsonrpc: '2.0', protocol: protocolMarker, ...payload }, hostOrigin)
    }

    const request = (method: string, params: unknown): Promise<unknown> => {
      const id = nextId++
      return new Promise((resolveRequest) => {
        pending.set(id, resolveRequest)
        post({ id, method, params })
      })
    }

    const notify = (method: string, params: unknown) => post({ method, params })

    /** Run one host-requested tool and answer on the same request id. */
    const answerToolCall = async (requestId: unknown, name: string, args: unknown): Promise<void> => {
      const result = await callTool(resolveTools(), name, args)
      post({ id: requestId, result })
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
        if (data.method === 'tools/list') {
          post({
            id: data.id,
            result: { tools: toDescriptors(resolveTools()) },
          })
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
        const resolver = pending.get(data.id)
        if (resolver) {
          pending.delete(data.id)
          resolver(data.error ? { error: data.error } : data.result)
        }
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
      teardownSelection?.()
      teardownSelection = null
      teardownErrors?.()
      teardownErrors = null
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

    // The one `.then` in this file, and deliberate: it sits inside a Promise
    // executor, which cannot be async — returning a promise from one is an
    // anti-pattern, and the timeout above has to be able to reject. Rewriting
    // it as async/await would mean restructuring the deadline race for no gain.
    void request('ui/initialize', {
      protocolVersion,
      appName,
      // Declared, not assumed: the host only asks for a tool list when we say we
      // have one, so an app with no tools costs no request and no timeout.
      capabilities: {
        selection: watchSelection,
        tools: resolveTools().length > 0,
        auth,
      },
    }).then((result) => {
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
        sendContext: (context) => notify('ui/update-model-context', { context }),
        openChat: (prompt) => void request('ui/open-chat', prompt ? { prompt } : {}),
        reportError,
        hostContext,
        disconnect,
      })
    })
  })
}

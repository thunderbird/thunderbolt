/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Host half of the Mini App bridge: owns the frame's message channel, performs
 * the handshake, and forwards accepted context into `useMiniAppStore`.
 *
 * The validation core (`acceptGuestMessage`) is a pure function so the trust
 * boundary can be unit-tested without a DOM or a real frame — that check is the
 * one piece here where a silent regression would be a security bug rather than
 * a broken demo.
 */

import {
  isSupportedProtocolVersion,
  miniAppGuestMethods,
  miniAppHostMethods,
  miniAppProtocolMarker,
  miniAppProtocolVersion,
  miniAppRpcErrors,
  parseGuestMessage,
  parseGuestResult,
  selectionQueryResultSchema,
  toolsCallResultSchema,
  toolsListResultSchema,
  type MiniAppGuestMessage,
  type MiniAppHostRequest,
  type MiniAppRect,
  type MiniAppSelectionItem,
  type MiniAppToolCallResult,
  type MiniAppHostMessage,
  type MiniAppInitializeResult,
  type MiniAppSelection,
  type MiniAppTheme,
} from '@shared/mini-app-protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTheme } from '@/lib/theme-provider'
import { useMiniAppStore } from './mini-app-store'
import type { MiniAppDefinition } from './registry'

/** How long to wait for the guest's `initialize` before calling the app unreachable. */
const handshakeTimeoutMs = 8_000

/** How long to wait for the guest to resolve a marquee before giving up. */
const selectionQueryTimeoutMs = 2_000

/** Tool discovery happens once at connect; a slow app shouldn't stall the UI. */
const toolsRequestTimeoutMs = 3_000

/** A tool call blocks a model turn, so it gets more room than discovery. */
const toolCallTimeoutMs = 15_000

export type MiniAppBridgeStatus = 'connecting' | 'ready' | 'unreachable'

type AcceptOptions = {
  /** The frame's `contentWindow`; anything from elsewhere is not our app. */
  expectedWindow: Window | null
  /** The origin declared in the registry for this app. */
  expectedOrigin: string
}

/**
 * Decide whether an inbound `message` event is a legitimate message from our
 * mini app, returning the parsed message or `null`.
 *
 * Three independent gates, all required:
 *  1. **Source window** — the event came from this frame, not another frame,
 *     the opener, or the top window.
 *  2. **Origin** — it matches the origin an operator registered. A frame that
 *     navigates itself somewhere else stops being trusted immediately.
 *  3. **Shape** — it parses as a known protocol message (`parseGuestMessage`).
 *
 * Source and origin are both checked because neither alone is sufficient: origin
 * alone would accept a *different* frame on the same origin, and source alone
 * would keep trusting our frame after it navigated away.
 */
export const isFromGuest = (
  event: Pick<MessageEvent, 'source' | 'origin'>,
  { expectedWindow, expectedOrigin }: AcceptOptions,
): boolean => {
  if (!expectedWindow || event.source !== expectedWindow) {
    return false
  }
  return event.origin === expectedOrigin
}

export const acceptGuestMessage = (
  event: Pick<MessageEvent, 'source' | 'origin' | 'data'>,
  options: AcceptOptions,
): MiniAppGuestMessage | null => (isFromGuest(event, options) ? parseGuestMessage(event.data) : null)

/** Resolve the app's theme setting to the concrete appearance the guest needs. */
const resolveTheme = (theme: string): MiniAppTheme => {
  if (theme === 'dark' || theme === 'light') {
    return theme
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export type UseMiniAppBridgeOptions = {
  app: MiniAppDefinition
  /** Called when the guest sends `chat/open`. */
  onChatOpen: (prompt: string | undefined) => void
}

export const useMiniAppBridge = ({ app, onChatOpen }: UseMiniAppBridgeOptions) => {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [status, setStatus] = useState<MiniAppBridgeStatus>('connecting')
  // Selection is host UI state, not model context — it drives the floating
  // control and is only promoted into the conversation when the user acts on it.
  // Keeping it out of `useMiniAppStore` means a stray highlight never reaches the
  // prompt or the `get_app_context` tool.
  const [selection, setSelection] = useState<MiniAppSelection | null>(null)
  const { theme } = useTheme()
  const setContext = useMiniAppStore((s) => s.setContext)
  const setTools = useMiniAppStore((s) => s.setTools)

  // Held in a ref so a new callback identity from the parent doesn't tear down
  // and re-add the message listener mid-session (which would drop in-flight
  // messages and, worse, re-run the handshake timeout).
  const onChatOpenRef = useRef(onChatOpen)
  onChatOpenRef.current = onChatOpen

  // In-flight host→guest requests, keyed by JSON-RPC id. Only `selection/query`
  // uses this today; it exists because resolving a marquee to content is the one
  // thing the host genuinely cannot do itself.
  // What the guest declared at handshake. A ref, not state: it's read inside the
  // message handler and by the discovery effect, and re-rendering on it would
  // only churn the listener.
  const guestCapabilitiesRef = useRef<{ tools?: boolean; selection?: boolean }>({})
  const pendingRef = useRef(new Map<number, (result: unknown) => void>())
  const nextRequestIdRef = useRef(1)

  const post = useCallback(
    (message: MiniAppHostMessage) => {
      // Targeted origin, never '*': the frame may have navigated, and a wildcard
      // would hand our payload to whatever is there now.
      frameRef.current?.contentWindow?.postMessage(message, app.origin)
    },
    [app.origin],
  )

  /**
   * Subscribe to the frame's messages for as long as this app is mounted.
   *
   * A legitimate `useEffect` per CLAUDE.md: a DOM event listener with cleanup on
   * an external system (the embedded frame).
   */
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const trust = { expectedWindow: frameRef.current?.contentWindow ?? null, expectedOrigin: app.origin }

      // A reply to something we asked. Checked first: results carry no `method`,
      // so they'd fail method dispatch.
      const reply = isFromGuest(event, trust) ? parseGuestResult(event.data) : null
      if (reply && typeof reply.id === 'number') {
        const resolve = pendingRef.current.get(reply.id)
        if (resolve) {
          pendingRef.current.delete(reply.id)
          resolve(reply.result)
        }
        return
      }

      const message = acceptGuestMessage(event, trust)
      if (!message) {
        return
      }

      if (message.method === miniAppGuestMethods.initialize) {
        if (!isSupportedProtocolVersion(message.params.protocolVersion)) {
          post({
            jsonrpc: '2.0',
            protocol: miniAppProtocolMarker,
            id: message.id,
            error: {
              code: miniAppRpcErrors.unsupportedProtocolVersion,
              message: `unsupported protocol version ${message.params.protocolVersion}; host speaks ${miniAppProtocolVersion}`,
            },
          })
          return
        }
        guestCapabilitiesRef.current = message.params.capabilities
        const result: MiniAppInitializeResult = {
          protocolVersion: miniAppProtocolVersion,
          hostName: 'Thunderbolt',
          capabilities: { context: true, chat: true },
          theme: resolveTheme(theme),
        }
        post({ jsonrpc: '2.0', protocol: miniAppProtocolMarker, id: message.id, result })
        setStatus('ready')
        return
      }

      if (message.method === miniAppGuestMethods.contextUpdate) {
        setContext(message.params.context)
        return
      }

      if (message.method === miniAppGuestMethods.selectionChanged) {
        setSelection(message.params.selection)
        return
      }

      // chat/open — acknowledge before acting so a slow panel animation can't
      // look like a dropped request to the guest.
      post({ jsonrpc: '2.0', protocol: miniAppProtocolMarker, id: message.id, result: { opened: true } })
      onChatOpenRef.current(message.params.prompt)
    }

    window.addEventListener('message', handleMessage)
    const pending = pendingRef.current
    return () => {
      window.removeEventListener('message', handleMessage)
      // Resolve rather than leak: a caller awaiting a query when the user
      // navigates away should get an empty answer, not a promise that never settles.
      for (const resolve of pending.values()) {
        resolve(null)
      }
      pending.clear()
    }
  }, [app.origin, post, setContext, theme])

  /**
   * Fail visibly when the guest never handshakes — an app that isn't running
   * would otherwise render as an indefinitely blank panel, which is the single
   * most confusing failure mode when demoing.
   */
  useEffect(() => {
    if (status !== 'connecting') {
      return
    }
    const timer = setTimeout(() => setStatus('unreachable'), handshakeTimeoutMs)
    return () => clearTimeout(timer)
  }, [status])

  /** Keep the guest's appearance in step with the host's. */
  useEffect(() => {
    if (status !== 'ready') {
      return
    }
    post({
      jsonrpc: '2.0',
      protocol: miniAppProtocolMarker,
      method: miniAppHostMethods.themeChanged,
      params: { theme: resolveTheme(theme) },
    })
  }, [theme, status, post])

  /** Drop the current selection — used after the host acts on it. */
  const clearSelection = useCallback(() => setSelection(null), [])

  /**
   * Send a request into the frame and await its reply.
   *
   * Always settles: an unanswered request resolves to `null` after `timeoutMs`
   * rather than hanging. Every caller here would otherwise be blocking either a
   * UI affordance or a model turn, and a guest that stops replying is a case we
   * have to assume rather than hope against.
   */
  const request = useCallback(
    (method: MiniAppHostRequest['method'], params: unknown, timeoutMs: number): Promise<unknown> =>
      new Promise((resolve) => {
        const id = nextRequestIdRef.current++
        const pending = pendingRef.current
        const settle = (result: unknown) => {
          clearTimeout(timer)
          pending.delete(id)
          resolve(result)
        }
        const timer = setTimeout(() => settle(null), timeoutMs)
        pending.set(id, settle)
        post({ jsonrpc: '2.0', protocol: miniAppProtocolMarker, id, method, params })
      }),
    [post],
  )

  /** Invoke a tool inside the frame, normalising failures into a tool-visible error. */
  const callTool = useCallback(
    async (name: string, args: unknown): Promise<MiniAppToolCallResult> => {
      const result = await request(miniAppHostMethods.toolsCall, { name, arguments: args }, toolCallTimeoutMs)
      const parsed = toolsCallResultSchema.safeParse(result)
      if (!parsed.success) {
        // The model reads this, so say what happened rather than throwing — a
        // thrown tool error reads to the model as "the app is broken", when the
        // likely truth is "the app took too long".
        return { content: `The ${name} tool did not return a usable result. It may have timed out.`, isError: true }
      }
      return parsed.data
    },
    [request],
  )

  /**
   * Ask the guest what a marquee rectangle covers.
   *
   * Resolves to `[]` on anything unexpected — a guest that never answers, answers
   * late, or answers with a shape we don't recognise. A selection tool that
   * silently selects nothing is recoverable; one that hangs the UI is not.
   */
  const querySelection = useCallback(
    (rect: MiniAppRect): Promise<MiniAppSelectionItem[]> =>
      request(miniAppHostMethods.selectionQuery, { rect }, selectionQueryTimeoutMs).then((result) => {
        const parsed = selectionQueryResultSchema.safeParse(result)
        return parsed.success ? parsed.data.items : []
      }),
    [request],
  )

  /**
   * Discover the app's tools once it's connected and has declared the capability.
   *
   * Gated on the declaration rather than asked speculatively: an app that never
   * implements `tools/list` would otherwise cost a request and a timeout on every
   * connect, and the host would have no way to tell "no tools" from "not answering".
   */
  useEffect(() => {
    if (status !== 'ready' || !guestCapabilitiesRef.current.tools) {
      return
    }
    let cancelled = false
    void request(miniAppHostMethods.toolsList, {}, toolsRequestTimeoutMs).then((result) => {
      const parsed = toolsListResultSchema.safeParse(result)
      if (cancelled || !parsed.success) {
        return
      }
      setTools(parsed.data.tools, callTool)
    })
    return () => {
      cancelled = true
    }
    // `callTool` and `request` are stable for the life of a connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, request, setTools])

  return { frameRef, status, selection, clearSelection, querySelection }
}

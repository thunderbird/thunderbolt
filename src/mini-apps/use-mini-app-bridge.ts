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
  type MiniAppPlatform,
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
import { getPlatform, isIosPlatform, isTauri } from '@/lib/platform'
import { createPendingRequests } from '@/components/embedded/pending-requests'
import { useHttpClient } from '@/contexts'
import { fetchMiniAppToken } from './mini-app-auth'
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

/**
 * Which surface the frame is running in. Derived from the existing platform
 * helpers rather than sniffed again, so a Mini App and the rest of the app can
 * never disagree about where they are.
 */
const resolveHostPlatform = (): MiniAppPlatform => {
  if (isIosPlatform()) {
    return 'ios'
  }
  if (getPlatform() === 'android') {
    return 'android'
  }
  return isTauri() ? 'desktop' : 'web'
}

/** Resolve the app's theme setting to the concrete appearance the guest needs. */
const resolveTheme = (theme: string): MiniAppTheme => {
  if (theme === 'dark' || theme === 'light') {
    return theme
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export type UseMiniAppBridgeOptions = {
  app: MiniAppDefinition
  /** Called when the guest sends `ui/open-chat`. */
  onChatOpen: (prompt: string | undefined) => void
}

export const useMiniAppBridge = ({ app, onChatOpen }: UseMiniAppBridgeOptions) => {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const httpClient = useHttpClient()
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
  /*
   * Read through a ref, not a dependency. The handler needs the *current* theme
   * when it answers `initialize`, but listing `theme` as a dependency tore the
   * listener down and rebuilt it on every appearance change — and the cleanup
   * calls `pending.abortAll()`, so switching to dark mode cancelled whatever
   * tool call was in flight. Changes still reach the guest: the effect below
   * pushes them as a host-context patch.
   */
  const themeRef = useRef(theme)
  themeRef.current = theme

  // In-flight host→guest requests, keyed by JSON-RPC id. Only `ui/selection-query`
  // uses this today; it exists because resolving a marquee to content is the one
  // thing the host genuinely cannot do itself.
  // What the guest declared at handshake. A ref, not state: it's read inside the
  // message handler and by the discovery effect, and re-rendering on it would
  // only churn the listener.
  const guestCapabilitiesRef = useRef<{ tools?: boolean; selection?: boolean }>({})
  // Correlation, timeouts and always-settling are shared with artifacts — see
  // `pending-requests.ts`. Only the envelope and the trust check differ.
  const [pending] = useState(() => createPendingRequests())

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
    // Async because two branches mint tokens over the network. `addEventListener`
    // ignores the returned promise, which is fine — nothing awaits the handler,
    // and each branch posts its own reply when it resolves.
    const handleMessage = async (event: MessageEvent) => {
      const trust = { expectedWindow: frameRef.current?.contentWindow ?? null, expectedOrigin: app.origin }

      // A reply to something we asked. Checked first: results carry no `method`,
      // so they'd fail method dispatch.
      const reply = isFromGuest(event, trust) ? parseGuestResult(event.data) : null
      if (reply && typeof reply.id === 'number') {
        // A reported failure settles as a tool-shaped error result, which is
        // what both waiters already expect: `callTool` hands the message
        // straight to the model, and `querySelection` fails its own parse and
        // falls back to an empty selection. The alternative — dropping the
        // reply — left the request hanging until its timeout, so an app that
        // said "that threw" looked exactly like an app that said nothing.
        pending.settle(reply.id, reply.error ? { content: reply.error.message, isError: true } : reply.result)
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

        // Only minted when the guest declared the capability — an app that never
        // asked shouldn't cause a credential to exist.
        const auth = message.params.capabilities.auth ? await fetchMiniAppToken(httpClient, app.id) : null

        const result: MiniAppInitializeResult = {
          protocolVersion: miniAppProtocolVersion,
          hostName: 'Thunderbolt',
          capabilities: { context: true, chat: true, auth: auth !== null },
          hostContext: {
            theme: resolveTheme(themeRef.current),
            locale: navigator.language,
            platform: resolveHostPlatform(),
          },
          ...(auth ? { auth } : {}),
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

      if (message.method === miniAppGuestMethods.requestAuthToken) {
        const refreshed = await fetchMiniAppToken(httpClient, app.id)
        post(
          refreshed
            ? { jsonrpc: '2.0', protocol: miniAppProtocolMarker, id: message.id, result: refreshed }
            : {
                jsonrpc: '2.0',
                protocol: miniAppProtocolMarker,
                id: message.id,
                error: { code: miniAppRpcErrors.authUnavailable, message: 'no identity token available' },
              },
        )
        return
      }

      // ui/open-chat — acknowledge before acting so a slow panel animation can't
      // look like a dropped request to the guest.
      post({ jsonrpc: '2.0', protocol: miniAppProtocolMarker, id: message.id, result: { opened: true } })
      onChatOpenRef.current(message.params.prompt)
    }

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
      // Resolve rather than leak: a caller awaiting a query when the user
      // navigates away should get an empty answer, not a promise that never settles.
      pending.abortAll()
    }
    // `httpClient` and `app.id` are dependencies, not incidental reads: minting
    // a token against a stale client is the kind of bug that only shows up once
    // settings load a beat after first render. Re-subscribing is cheap — but
    // only for things that genuinely change identity, which is why `theme` is a
    // ref above rather than listed here.
  }, [app.id, app.origin, httpClient, pending, post, setContext])

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
      method: miniAppHostMethods.hostContextChanged,
      // Partial by design — only the key that moved.
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
      pending.issue((id) => post({ jsonrpc: '2.0', protocol: miniAppProtocolMarker, id, method, params }), timeoutMs),
    [post, pending],
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

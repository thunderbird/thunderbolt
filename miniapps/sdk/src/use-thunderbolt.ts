/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use client'

/**
 * React binding over `thunderbolt-bridge.ts`.
 *
 * Kept separate from the transport so the bridge itself stays framework-free —
 * a customer on Vue or Svelte copies only the other file.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { connect, type AuthToken, type Connection, type HostContext, type MiniAppContext } from './bridge'
import type { ThunderboltTool } from './tools'

export type ThunderboltState = {
  /** True once the host has answered the handshake. */
  connected: boolean
  /** Host theme, locale and surface. Sensible defaults when running standalone. */
  hostContext: HostContext
  /** Publish the current view. No-op when not embedded. */
  sendContext: (context: MiniAppContext) => void
  /** Ask the host to open its chat panel. No-op when not embedded. */
  openChat: (prompt?: string) => void
  /**
   * A valid identity token, refreshed as needed. Null when running standalone
   * or when the host has no audience configured for this app.
   */
  getAuthToken: () => Promise<AuthToken | null>
}

/**
 * `tools` accepts a getter as well as an array — the bridge itself already does,
 * and it lets a component call this hook *before* the tools are defined. That
 * matters when the tool bodies need something the hook returns (the host locale,
 * say), which would otherwise be a chicken-and-egg between the two.
 */
export const useThunderbolt = (
  appName: string,
  tools: ThunderboltTool[] | (() => ThunderboltTool[]) = [],
  options: { auth?: boolean } = {},
): ThunderboltState => {
  const [connected, setConnected] = useState(false)
  // Patched rather than replaced: host-context updates carry only what changed.
  const [hostContext, setHostContext] = useState<HostContext>({ theme: 'light', locale: 'en', platform: 'web' })
  const connectionRef = useRef<Connection | null>(null)
  // Tools are read through a ref so redefining the array each render (which any
  // app using closures over state will do) doesn't tear down and rebuild the
  // connection. The closures inside stay live because the ref is reassigned.
  const toolsRef = useRef(tools)
  toolsRef.current = tools

  useEffect(() => {
    let cancelled = false

    const open = async (): Promise<void> => {
      try {
        const connection = await connect({
          appName,
          onHostContextChange: (patch) => setHostContext((current) => ({ ...current, ...patch })),
          tools: () => (typeof toolsRef.current === 'function' ? toolsRef.current() : toolsRef.current),
          auth: options.auth,
        })
        // A late handshake after unmount would otherwise leave a live listener
        // and a connection nobody can disconnect.
        if (cancelled) {
          connection.disconnect()
          return
        }
        connectionRef.current = connection
        setConnected(true)
      } catch {
        // Running standalone in a browser tab is a supported mode, not an error —
        // the app stays fully usable, just without the chat integration.
      }
    }

    void open()

    return () => {
      cancelled = true
      connectionRef.current?.disconnect()
      connectionRef.current = null
    }
  }, [appName])

  // Memoised because callers put these in effect dependency arrays. Rebuilding
  // them each render made the context-publishing effect fire on every render,
  // posting an identical message across the bridge each time.
  const sendContext = useCallback((context: MiniAppContext) => connectionRef.current?.sendContext(context), [])
  const openChat = useCallback((prompt?: string) => connectionRef.current?.openChat(prompt), [])
  const getAuthToken = useCallback(async () => (await connectionRef.current?.getAuthToken()) ?? null, [])

  return { connected, hostContext, sendContext, openChat, getAuthToken }
}

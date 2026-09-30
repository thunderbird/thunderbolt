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
import {
  connect,
  NotEmbeddedError,
  type AuthToken,
  type Connection,
  type HostContext,
  type MiniAppContext,
} from './bridge'
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
  /**
   * Why the connection failed, when it failed for a reason worth showing.
   *
   * Null both when connected and when simply not embedded — running standalone
   * in a browser tab is a supported mode, not a fault. Anything else (a refused
   * handshake, an unsupported protocol version, a handshake timeout) lands here
   * so the app can say something better than nothing.
   */
  connectionError: string | null
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
  options: {
    auth?: boolean
    /**
     * The Thunderbolt origin to talk to, and to trust replies from.
     *
     * Defaults to the dev server, which is why this has to be reachable from
     * here: `connect` has always accepted it, but the hook did not pass it on,
     * so the shipped React path could only ever target `http://localhost:1420`
     * and there was no way to deploy an app against a real host.
     */
    hostOrigin?: string
  } = {},
): ThunderboltState => {
  const [connected, setConnected] = useState(false)
  // Patched rather than replaced: host-context updates carry only what changed.
  const [hostContext, setHostContext] = useState<HostContext>({ theme: 'light', locale: 'en', platform: 'web' })
  const [connectionError, setConnectionError] = useState<string | null>(null)
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
          hostOrigin: options.hostOrigin,
        })
        // A late handshake after unmount would otherwise leave a live listener
        // and a connection nobody can disconnect.
        if (cancelled) {
          connection.disconnect()
          return
        }
        connectionRef.current = connection
        setConnected(true)
      } catch (error) {
        if (cancelled) {
          return
        }
        /*
         * Not embedded is a mode; everything else is a fault.
         *
         * This used to be a bare `catch` that called all of them standalone,
         * which is right for the common case and wrong for every other one: a
         * refused handshake, an unsupported protocol version, a timeout and a
         * bug in here all looked identical, and the only symptom was a generic
         * unreachable panel with the cause discarded.
         */
        if (error instanceof NotEmbeddedError) {
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        setConnectionError(message)
        // Reaches the host too: it forwards guest console errors into the panel
        // strip, which is the one place a developer is already looking.
        console.error('Mini App could not connect to Thunderbolt:', message)
      }
    }

    void open()

    return () => {
      cancelled = true
      connectionRef.current?.disconnect()
      connectionRef.current = null
    }
  }, [appName, options.auth, options.hostOrigin])

  // Memoised because callers put these in effect dependency arrays. Rebuilding
  // them each render made the context-publishing effect fire on every render,
  // posting an identical message across the bridge each time.
  const sendContext = useCallback((context: MiniAppContext) => connectionRef.current?.sendContext(context), [])
  const openChat = useCallback((prompt?: string) => connectionRef.current?.openChat(prompt), [])
  const getAuthToken = useCallback(async () => (await connectionRef.current?.getAuthToken()) ?? null, [])

  return { connected, hostContext, sendContext, openChat, getAuthToken, connectionError }
}

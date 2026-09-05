/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Holds the currently open Mini App and the latest context it published.
 *
 * This is a store rather than React context because its main consumer is not a
 * component: `src/ai/fetch.ts` builds the toolset and system prompt outside the
 * React tree and cannot read a hook. `useChatStore` and `useLocalSettingsStore`
 * solve the same problem the same way.
 *
 * The context here is a cache of the last `ui/update-model-context` the guest pushed —
 * the protocol has no pull. That is the contract: an app must publish on every
 * meaningful change, and in exchange the host never blocks a tool call on a
 * round-trip to the frame.
 */

import { create } from 'zustand'
import { useChatStore } from '@/chats/chat-store'
import type { MiniAppContext, MiniAppTool, MiniAppToolCallResult } from '@shared/mini-app-protocol'
import type { MiniAppDefinition } from './registry'

/** Invokes a tool inside the frame. Installed by the bridge while an app is open. */
export type MiniAppToolInvoker = (name: string, args: unknown) => Promise<MiniAppToolCallResult>

type MiniAppState = {
  /** The app whose route is currently mounted, or null when none is open. */
  activeApp: MiniAppDefinition | null
  /** Latest context published by the active app; null before its first update. */
  context: MiniAppContext | null
  /** Tools the active app exposes; empty until `tools/list` returns. */
  tools: MiniAppTool[]
  /** Bridge-installed invoker, or null when no app is connected. */
  invokeTool: MiniAppToolInvoker | null
  /**
   * When this app opened, for deciding which surface `get_app_context`
   * describes when an artifact panel is also open. Compared against the
   * artifact store's `openedAt`, so the two have to mean the same thing.
   */
  openedAt: number | null
}

type MiniAppActions = {
  /** Mark an app as open. Clears state left over from a previous app. */
  openApp: (app: MiniAppDefinition) => void
  /** Clear everything — the route unmounted. */
  closeApp: () => void
  /** Record a context update from the active app. */
  setContext: (context: MiniAppContext) => void
  /** Publish the app's tool list and how to call them. */
  setTools: (tools: MiniAppTool[], invokeTool: MiniAppToolInvoker) => void
  /**
   * Forget everything the guest told us, but keep the app open.
   *
   * For a re-handshake: the frame is still mounted on the same app, but the
   * document behind it has been replaced (navigation, reload, redeploy). Its
   * tools and context describe a page that no longer exists.
   */
  resetGuest: () => void
}

const emptyAppState = { activeApp: null, context: null, tools: [], invokeTool: null, openedAt: null }

export const useMiniAppStore = create<MiniAppState & MiniAppActions>((set, get) => ({
  ...emptyAppState,
  openApp: (app) => set({ ...emptyAppState, activeApp: app, openedAt: Date.now() }),
  closeApp: () => {
    const { activeApp } = get()
    set(emptyAppState)
    // Deny everything still waiting on this app, wherever it was asked: the app
    // they would have acted on is gone, and a tool `execute` awaiting a prompt
    // nobody can answer hangs the turn. The queues live on the chat sessions
    // (see `PendingMiniAppApproval`), so the sweep goes through the chat store.
    if (activeApp) {
      useChatStore.getState().cancelMiniAppApprovals(activeApp.id)
    }
  },
  setContext: (context) => set({ context }),
  setTools: (tools, invokeTool) => set({ tools, invokeTool }),
  resetGuest: () => {
    const { activeApp } = get()
    set({ context: null, tools: [], invokeTool: null })
    // Same reasoning as `closeApp`: the document that would have serviced these
    // approvals is gone, so nothing can honour them.
    if (activeApp) {
      useChatStore.getState().cancelMiniAppApprovals(activeApp.id)
    }
  },
}))

/**
 * Read the active app + context outside React (prompt assembly, tool calls).
 * Returns a snapshot, so callers get a consistent pair rather than two reads
 * that could straddle an update.
 */
export const getMiniAppSnapshot = (): {
  app: MiniAppDefinition | null
  context: MiniAppContext | null
  tools: MiniAppTool[]
  openedAt: number | null
} => {
  const { activeApp, context, tools, openedAt } = useMiniAppStore.getState()
  return { app: activeApp, context, tools, openedAt }
}

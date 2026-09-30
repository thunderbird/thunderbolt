/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Holds the currently open Mini App and the tools it declared.
 *
 * This is a store rather than React context because its main consumer is not a
 * component: `src/ai/fetch.ts` builds the toolset and system prompt outside the
 * React tree and cannot read a hook. `useChatStore` and `useLocalSettingsStore`
 * solve the same problem the same way.
 *
 * No context is held here, deliberately. It used to cache the last context the
 * guest pushed, which meant an app had to re-publish on every meaningful change
 * and one it forgot left the model describing a screen the user had left —
 * confidently, because nothing marks a cache as stale. The host now asks the
 * frame on every `get_app_context` (`ui/get-context`), so the answer is either
 * current or an honest "unavailable" (THU-910).
 */

import { create } from 'zustand'
import { useChatStore } from '@/chats/chat-store'
import type { MiniAppContext, MiniAppTool, MiniAppToolCallResult } from '@shared/mini-app-protocol'
import type { MiniAppDefinition } from './registry'

/** Invokes a tool inside the frame. Installed by the bridge while an app is open. */
export type MiniAppToolInvoker = (name: string, args: unknown) => Promise<MiniAppToolCallResult>

/**
 * Asks the frame what the user is looking at. Installed by the bridge.
 *
 * Here rather than in the state because `get_app_context` runs outside React,
 * in `src/ai/fetch.ts`, and the frame it has to ask lives inside a component —
 * exactly the reason `invokeTool` is installed the same way.
 */
export type MiniAppContextReader = () => Promise<MiniAppContext | null>

type MiniAppState = {
  /** The app whose route is currently mounted, or null when none is open. */
  activeApp: MiniAppDefinition | null
  /** Tools the active app exposes; empty until `tools/list` returns. */
  tools: MiniAppTool[]
  /** Bridge-installed invoker, or null when no app is connected. */
  invokeTool: MiniAppToolInvoker | null
  /** Bridge-installed context reader, or null when no app is connected. */
  requestContext: MiniAppContextReader | null
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
  /** Publish the app's tool list and how to call them. */
  setTools: (tools: MiniAppTool[], invokeTool: MiniAppToolInvoker) => void
  /** Install the way to read the app's live context. */
  setContextReader: (requestContext: MiniAppContextReader) => void
  /**
   * Forget everything the guest told us, but keep the app open.
   *
   * For a re-handshake: the frame is still mounted on the same app, but the
   * document behind it has been replaced (navigation, reload, redeploy). Its
   * tools describe a page that no longer exists.
   */
  resetGuest: () => void
}

const emptyAppState = { activeApp: null, tools: [], invokeTool: null, requestContext: null, openedAt: null }

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
  setTools: (tools, invokeTool) => set({ tools, invokeTool }),
  setContextReader: (requestContext) => set({ requestContext }),
  resetGuest: () => {
    const { activeApp } = get()
    set({ tools: [], invokeTool: null, requestContext: null })
    // Same reasoning as `closeApp`: the document that would have serviced these
    // approvals is gone, so nothing can honour them.
    if (activeApp) {
      useChatStore.getState().cancelMiniAppApprovals(activeApp.id)
    }
  },
}))

/**
 * Read the active app and its tools outside React (prompt assembly, tool calls).
 * Returns a snapshot, so callers get a consistent pair rather than two reads
 * that could straddle an update.
 */
export const getMiniAppSnapshot = (): {
  app: MiniAppDefinition | null
  tools: MiniAppTool[]
  openedAt: number | null
} => {
  const { activeApp, tools, openedAt } = useMiniAppStore.getState()
  return { app: activeApp, tools, openedAt }
}

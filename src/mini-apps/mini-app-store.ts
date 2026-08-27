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
import type { MiniAppContext, MiniAppTool, MiniAppToolCallResult } from '@shared/mini-app-protocol'
import type { MiniAppDefinition } from './registry'

/** Invokes a tool inside the frame. Installed by the bridge while an app is open. */
export type MiniAppToolInvoker = (name: string, args: unknown) => Promise<MiniAppToolCallResult>

/** A tool call waiting on the user, and the promise it is blocking. */
export type PendingToolApproval = {
  tool: MiniAppTool
  args: unknown
  /** Resolves the blocked `execute`. */
  decide: (approved: boolean) => void
}

type MiniAppState = {
  /** The app whose route is currently mounted, or null when none is open. */
  activeApp: MiniAppDefinition | null
  /** Latest context published by the active app; null before its first update. */
  context: MiniAppContext | null
  /** Tools the active app exposes; empty until `tools/list` returns. */
  tools: MiniAppTool[]
  /** Bridge-installed invoker, or null when no app is connected. */
  invokeTool: MiniAppToolInvoker | null
  /** The approval prompt currently on screen, if any. */
  pendingApproval: PendingToolApproval | null
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
   * Block on user approval for a write tool. Resolves false when no app is open,
   * so a call that races an unmount is denied rather than left hanging.
   */
  requestApproval: (tool: MiniAppTool, args: unknown) => Promise<boolean>
  /** Answer the on-screen prompt. */
  resolveApproval: (approved: boolean) => void
}

const emptyAppState = { activeApp: null, context: null, tools: [], invokeTool: null, pendingApproval: null }

export const useMiniAppStore = create<MiniAppState & MiniAppActions>((set, get) => ({
  ...emptyAppState,
  openApp: (app) => set({ ...emptyAppState, activeApp: app }),
  closeApp: () => {
    // Deny anything still waiting: the app it would have acted on is gone, and a
    // tool `execute` awaiting a prompt nobody can answer would hang the turn.
    get().pendingApproval?.decide(false)
    set(emptyAppState)
  },
  setContext: (context) => set({ context }),
  setTools: (tools, invokeTool) => set({ tools, invokeTool }),
  requestApproval: (tool, args) =>
    new Promise<boolean>((resolve) => {
      if (!get().activeApp) {
        resolve(false)
        return
      }
      // Supersede rather than queue: a second prompt behind the first would be
      // invisible, and the model shouldn't have two writes in flight anyway.
      get().pendingApproval?.decide(false)
      set({
        pendingApproval: {
          tool,
          args,
          decide: (approved) => {
            set({ pendingApproval: null })
            resolve(approved)
          },
        },
      })
    }),
  resolveApproval: (approved) => get().pendingApproval?.decide(approved),
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
} => {
  const { activeApp, context, tools } = useMiniAppStore.getState()
  return { app: activeApp, context, tools }
}

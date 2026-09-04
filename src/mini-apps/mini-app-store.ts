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
  /**
   * Write-tool calls waiting on the user, oldest first. The head is the one on
   * screen; the rest are queued behind it, each still holding its own turn open.
   */
  approvalQueue: PendingToolApproval[]
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
  /**
   * Block on user approval for a write tool. Resolves false when no app is open,
   * so a call that races an unmount is denied rather than left hanging.
   */
  requestApproval: (tool: MiniAppTool, args: unknown) => Promise<boolean>
  /** Answer the prompt on screen — the head of the queue. */
  resolveApproval: (approved: boolean) => void
}

/**
 * How long an unanswered approval prompt waits before denying itself.
 *
 * Two minutes: long enough to read the prompt, look at the app and think, short
 * enough that a turn nobody is coming back to eventually ends instead of
 * spinning forever.
 */
const approvalTimeoutMs = 120_000

const emptyAppState = { activeApp: null, context: null, tools: [], invokeTool: null, approvalQueue: [] }

export const useMiniAppStore = create<MiniAppState & MiniAppActions>((set, get) => ({
  ...emptyAppState,
  openApp: (app) => set({ ...emptyAppState, activeApp: app }),
  closeApp: () => {
    // Deny everything still waiting: the app they would have acted on is gone,
    // and a tool `execute` awaiting a prompt nobody can answer hangs the turn.
    get().approvalQueue.forEach((pending) => pending.decide(false))
    set(emptyAppState)
  },
  setContext: (context) => set({ context }),
  setTools: (tools, invokeTool) => set({ tools, invokeTool }),
  resetGuest: () => {
    // Same reasoning as `closeApp`: the document that would have serviced these
    // approvals is gone, so nothing can honour them.
    get().approvalQueue.forEach((pending) => pending.decide(false))
    set({ context: null, tools: [], invokeTool: null, approvalQueue: [] })
  },
  requestApproval: (tool, args) =>
    new Promise<boolean>((resolve) => {
      if (!get().activeApp) {
        resolve(false)
        return
      }
      /*
       * Deny on a deadline.
       *
       * This promise is holding the model's streaming request open, so a prompt
       * the user walks away from doesn't just sit there — it wedges the turn,
       * with a spinner and no explanation. Denying is the safe default and the
       * model is told why, so it can say something useful instead of stalling.
       *
       * The window is deliberately long: a decision about someone's data is
       * worth reading properly, and the cost of being slightly too patient is
       * much lower than the cost of approving something by timeout.
       *
       * The clock starts when the call is made, not when its prompt reaches the
       * screen. A queued call is holding its turn open just as much as the one
       * on screen is.
       */
      const timer = setTimeout(() => pending.decide(false), approvalTimeoutMs)

      const pending: PendingToolApproval = {
        tool,
        args,
        decide: (approved) => {
          clearTimeout(timer)
          // Drop by identity, not by position: this may be answering from the
          // queue's middle if its own deadline expired while another was up.
          set((state) => ({ approvalQueue: state.approvalQueue.filter((entry) => entry !== pending) }))
          resolve(approved)
        },
      }

      /*
       * Queue, don't supersede.
       *
       * This used to deny whatever was already waiting, reasoning that a second
       * prompt behind the first would be invisible and the model shouldn't have
       * two writes in flight anyway. Nothing stops it: the AI SDK runs a step's
       * tool calls concurrently, so a model emitting two writes in one response
       * had the first auto-denied before the user ever saw it — and was told the
       * user had declined it. One prompt after another is exactly what someone
       * asked to approve two things expects.
       */
      set((state) => ({ approvalQueue: [...state.approvalQueue, pending] }))
    }),
  resolveApproval: (approved) => get().approvalQueue[0]?.decide(approved),
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

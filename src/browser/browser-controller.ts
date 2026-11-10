/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type Panel = { listTabs: () => { id: string }[] }
type ControlState = { busyTabId: string | null; paused: boolean }
type AgentTurn = { lifetime: AbortController; tabId: string | null; order: number }

/** Share agent activity and Stop across all page adapters; pageController owns operations. */
export const createBrowserController = () => {
  let panel: Panel | null = null
  let pageControl = new AbortController()
  let activityOrder = 0
  let state: ControlState = { busyTabId: null, paused: false }
  const turns = new Map<string, AgentTurn>()
  const listeners = new Set<() => void>()
  const publish = (next: ControlState) => {
    if (state.busyTabId === next.busyTabId && state.paused === next.paused) {
      return
    }
    state = next
    listeners.forEach((listener) => listener())
  }
  const publishActivity = () => {
    const latest = [...turns.values()].filter((turn) => turn.tabId).sort((a, b) => b.order - a.order)[0]
    publish({ ...state, busyTabId: state.paused ? null : (latest?.tabId ?? null) })
  }
  const forgetTab = (id?: string) => {
    for (const turn of turns.values()) {
      if (!id || turn.tabId === id) {
        turn.tabId = null
      }
    }
    publishActivity()
  }
  const operations = (turn?: AgentTurn) => {
    const controlSignal = (signal?: AbortSignal) => {
      const combined = AbortSignal.any([
        pageControl.signal,
        ...(signal ? [signal] : []),
        ...(turn ? [turn.lifetime.signal] : []),
      ])
      combined.throwIfAborted()
      return combined
    }
    return {
      assertControl: (signal?: AbortSignal) => controlSignal(signal),
      claimPage: (id: string, signal?: AbortSignal) => {
        const combined = controlSignal(signal)
        if (!panel?.listTabs().some((tab) => tab.id === id)) {
          throw new Error('Browser tab no longer exists. List pages again.')
        }
        if (turn) {
          turn.tabId = id
          turn.order = ++activityOrder
          publishActivity()
        }
        return combined
      },
      releasePage: (id: string) => forgetTab(id),
    }
  }
  return {
    ...operations(),
    registerPanel: (next: Panel) => {
      panel = next
      return () => {
        if (panel !== next) {
          return
        }
        panel = null
        const reason = new Error('Browser was closed.')
        pageControl.abort(reason)
        if (!state.paused) {
          pageControl = new AbortController()
        }
        for (const turn of turns.values()) {
          turn.lifetime.abort(reason)
        }
        turns.clear()
        publishActivity()
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getState: () => state,
    stop: () => {
      pageControl.abort(new Error('Page control stopped by the user. The user must resume it.'))
      publish({ busyTabId: null, paused: true })
      forgetTab()
    },
    resume: () => {
      if (!state.paused) {
        return
      }
      pageControl = new AbortController()
      publish({ ...state, paused: false })
    },
    /** Keep the banner visible through model thinking and retries until this exact turn finishes. */
    startAgentTurn: (id: string) => {
      turns.get(id)?.lifetime.abort(new Error('The agent turn was replaced.'))
      const turn: AgentTurn = { lifetime: new AbortController(), tabId: null, order: 0 }
      turns.set(id, turn)
      publishActivity()
      return () => {
        turn.lifetime.abort(new Error('The agent turn has finished.'))
        if (turns.get(id) === turn) {
          turns.delete(id)
        }
        publishActivity()
      }
    },
    /** Capture identity so late tools cannot claim a subsequent turn's activity. */
    forAgentTurn: (id: string) => {
      const turn = turns.get(id)
      if (turn) {
        return operations(turn)
      }
      const lifetime = new AbortController()
      lifetime.abort(new Error('The agent turn has finished.'))
      return operations({ lifetime, tabId: null, order: 0 })
    },
  }
}

export const browserController = createBrowserController()

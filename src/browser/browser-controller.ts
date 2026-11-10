/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { invoke } from '@tauri-apps/api/core'
import { normalizeBrowserUrl } from '@/content-view/browser-url'
import type { BrowserAction, BrowserSnapshot, BrowserTabInfo } from './types'

type Panel = {
  listTabs: () => BrowserTabInfo[]
  openTab: (url?: string, options?: { focusAddress?: boolean }) => string | undefined
  selectTab: (id: string) => void
  closeTab: (id: string, options?: { focusTab?: boolean }) => void
}
type Session = { label: string; present: () => Promise<void> }
type ControlState = { busyTabId: string | null; paused: boolean }
type NativeInvoke = typeof invoke
type AgentTurn = { lifetime: AbortController; tabId: string | null; order: number }
type Operation = { stop: AbortController; signal: AbortSignal; tabId: string | null; turn?: AgentTurn }

/** Own the privileged UI-to-native bridge without exposing an automation port to web pages. */
export const createBrowserController = (native: NativeInvoke = invoke) => {
  let panel: Panel | null = null
  let opener: ((url: string) => void) | null = null
  let reveal: (() => void) | null = null
  let generation = 0
  let controlEpoch = 0
  let pageControl = new AbortController()
  let queue = Promise.resolve()
  let current: Operation | null = null
  let activityOrder = 0
  let state: ControlState = { busyTabId: null, paused: false }
  const turns = new Map<string, AgentTurn>()
  const sessions = new Map<string, Session>()
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
    const runningTab = current && !current.signal.aborted ? current.tabId : null
    publish({ ...state, busyTabId: state.paused ? null : (runningTab ?? latest?.tabId ?? null) })
  }
  const forgetTab = (id?: string) => {
    for (const turn of turns.values()) {
      if (!id || turn.tabId === id) {
        turn.tabId = null
      }
    }
    if (current && (!id || current.tabId === id)) {
      current.tabId = null
    }
    publishActivity()
  }
  const check = (signal: AbortSignal, expected?: number) => {
    signal.throwIfAborted()
    if (state.paused) {
      throw new Error('Browser control was stopped by the user. The user must resume it.')
    }
    if (expected !== undefined && expected !== generation) {
      throw new Error('The browser session was closed.')
    }
  }
  const waitFor = async <T>(read: () => T | undefined | null | false, signal: AbortSignal, expected?: number) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      check(signal, expected)
      const value = read()
      if (value) {
        return value
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('Browser did not become ready. Check the browser panel and try again.')
  }
  const tab = (id: string) => {
    const value = panel?.listTabs().find((entry) => entry.id === id)
    if (!value) {
      throw new Error('Browser tab no longer exists. List tabs again.')
    }
    return value
  }
  const run = async <T>(
    task: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    turn?: AgentTurn,
  ): Promise<T> => {
    const requestedEpoch = controlEpoch
    const stop = new AbortController()
    const combined = AbortSignal.any([
      stop.signal,
      ...(signal ? [signal] : []),
      ...(turn ? [turn.lifetime.signal] : []),
    ])
    check(combined)
    const previous = queue
    const pending = (async () => {
      await previous
      if (requestedEpoch !== controlEpoch) {
        throw new Error('Browser control stopped by the user.')
      }
      check(combined)
      const operation: Operation = { stop, signal: combined, tabId: null, turn }
      current = operation
      try {
        return await task(combined)
      } finally {
        if (current === operation) {
          current = null
        }
        publishActivity()
      }
    })()
    queue = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }
  const activate = async (id: string, signal: AbortSignal) => {
    tab(id)
    const expected = generation
    reveal?.()
    panel?.selectTab(id)
    if (current) {
      current.tabId = id
      if (current.turn) {
        current.turn.tabId = id
        current.turn.order = ++activityOrder
      }
    }
    publishActivity()
    await waitFor(() => tab(id).active, signal, expected)
    const session = await waitFor(() => sessions.get(id), signal, expected)
    await session.present()
    check(signal, expected)
    return { session, expected }
  }
  const observe = async (id: string, session: Session, signal: AbortSignal, screenshot = false) => {
    check(signal)
    const result = await native<Omit<BrowserSnapshot, 'tabId'>>('browser_agent_snapshot', {
      label: session.label,
      screenshot,
    })
    check(signal)
    if (sessions.get(id) !== session) {
      throw new Error('Browser tab closed while observing it.')
    }
    return { ...result, tabId: id }
  }
  const settle = async (id: string, session: Session, signal: AbortSignal, expected: number) => {
    const deadline = Date.now() + 5000
    let idle = 0
    while (Date.now() < deadline && idle < 2) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      check(signal, expected)
      if (sessions.get(id) !== session) {
        throw new Error('Browser tab was closed.')
      }
      const page = await native<{ isLoading: boolean }>('browser_get_state', { label: session.label })
      idle = page.isLoading ? 0 : idle + 1
    }
  }
  const controls = {
    registerOpener: (open: (url: string) => void, show: () => void) => {
      opener = open
      reveal = show
      return () => {
        if (opener === open) {
          opener = null
          reveal = null
        }
      }
    },
    registerPanel: (next: Panel) => {
      panel = next
      generation += 1
      return () => {
        if (panel !== next) {
          return
        }
        panel = null
        generation += 1
        current?.stop.abort(new Error('Browser was closed.'))
        sessions.clear()
        forgetTab()
      }
    },
    registerSession: (id: string, session: Session) => {
      sessions.set(id, session)
      return () => {
        if (sessions.get(id) === session) {
          sessions.delete(id)
          forgetTab(id)
        }
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
      controlEpoch += 1
      pageControl.abort(new Error('Page control stopped by the user.'))
      publish({ busyTabId: null, paused: true })
      current?.stop.abort(new Error('Browser control stopped by the user.'))
      forgetTab()
    },
    resume: () => {
      pageControl = new AbortController()
      publish({ ...state, paused: false })
    },
  }
  const operations = (turn?: AgentTurn) => ({
    assertControl: (signal?: AbortSignal) =>
      check(
        AbortSignal.any([pageControl.signal, ...(signal ? [signal] : []), ...(turn ? [turn.lifetime.signal] : [])]),
      ),
    /** Share the turn lifetime and Stop control with iframe and mobile adapters. */
    claimPage: (id: string, signal?: AbortSignal) => {
      const combined = AbortSignal.any([
        pageControl.signal,
        ...(signal ? [signal] : []),
        ...(turn ? [turn.lifetime.signal] : []),
      ])
      check(combined)
      tab(id)
      if (turn) {
        turn.tabId = id
        turn.order = ++activityOrder
        publishActivity()
      }
      return combined
    },
    releasePage: (id: string) => forgetTab(id),
    listTabs: (): BrowserTabInfo[] => {
      turn?.lifetime.signal.throwIfAborted()
      return panel?.listTabs() ?? []
    },
    openTab: (url?: string, signal?: AbortSignal): Promise<BrowserTabInfo> =>
      run(
        async (signal) => {
          const target = !url || url === 'about:blank' ? 'about:blank' : normalizeBrowserUrl(url)
          if (!target) {
            throw new Error('Only HTTP(S) browser URLs are supported.')
          }
          let id: string | undefined
          if (panel) {
            id = panel.openTab(target === 'about:blank' ? undefined : target, { focusAddress: false })
          } else {
            if (!opener) {
              throw new Error('Desktop browser is unavailable in this view.')
            }
            opener(target)
            const opened = await waitFor(() => panel, signal)
            id = opened.listTabs().find((entry) => entry.active)?.id
          }
          if (!id) {
            throw new Error('Browser tab could not be opened.')
          }
          await waitFor(() => panel?.listTabs().some((entry) => entry.id === id), signal)
          await activate(id, signal)
          return tab(id)
        },
        signal,
        turn,
      ),
    selectTab: (id: string, signal?: AbortSignal): Promise<BrowserTabInfo> =>
      run(
        async (signal) => {
          await activate(id, signal)
          return tab(id)
        },
        signal,
        turn,
      ),
    closeTab: (id: string, signal?: AbortSignal): Promise<void> =>
      run(
        async (activeSignal) => {
          tab(id)
          panel?.closeTab(id, { focusTab: false })
          try {
            await waitFor(() => !panel?.listTabs().some((entry) => entry.id === id), activeSignal)
          } catch (error) {
            // Closing the last tab can tear down the panel and abort this operation itself.
            if (panel?.listTabs().some((entry) => entry.id === id)) {
              throw error
            }
          }
          forgetTab(id)
        },
        signal,
        turn,
      ),
    snapshot: (id: string, options?: { screenshot?: boolean; signal?: AbortSignal }): Promise<BrowserSnapshot> =>
      run(
        async (signal) => {
          const { session } = await activate(id, signal)
          return observe(id, session, signal, options?.screenshot)
        },
        options?.signal,
        turn,
      ),
    navigate: (
      id: string,
      action: { url: string } | { action: 'back' | 'forward' | 'reload' | 'stop' },
      signal?: AbortSignal,
    ): Promise<BrowserSnapshot> =>
      run(
        async (activeSignal) => {
          const { session, expected } = await activate(id, activeSignal)
          const url = 'url' in action ? normalizeBrowserUrl(action.url) : undefined
          if ('url' in action && !url) {
            throw new Error('Only HTTP(S) browser URLs are supported.')
          }
          await native(url ? 'browser_navigate' : 'browser_action', {
            label: session.label,
            ...(url ? { url } : action),
          })
          check(activeSignal, expected)
          await settle(id, session, activeSignal, expected)
          return observe(id, session, activeSignal)
        },
        signal,
        turn,
      ),
    act: (id: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserSnapshot> =>
      run(
        async (activeSignal) => {
          const { session, expected } = await activate(id, activeSignal)
          await native('browser_agent_action', { label: session.label, action })
          check(activeSignal, expected)
          await settle(id, session, activeSignal, expected)
          return observe(id, session, activeSignal)
        },
        signal,
        turn,
      ),
  })
  return {
    ...controls,
    ...operations(),
    /** Hold browser activity across model thinking and retries until this exact turn finishes. */
    startAgentTurn: (id: string) => {
      const turn: AgentTurn = { lifetime: new AbortController(), tabId: null, order: 0 }
      turns.set(id, turn)
      return () => {
        turn.lifetime.abort(new Error('The agent turn has finished.'))
        if (turns.get(id) === turn) {
          turns.delete(id)
        }
        publishActivity()
      }
    },
    /** Capture the turn identity so late tools cannot claim a subsequent turn's activity. */
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

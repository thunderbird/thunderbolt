/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import { useChatStore } from '@/chats/chat-store'
import type { MiniAppContext, MiniAppTool, MiniAppToolCallResult } from '@shared/mini-app-protocol'
import type { MiniAppDefinition } from './registry'

export type MiniAppToolInvoker = (name: string, args: unknown) => Promise<MiniAppToolCallResult>
export type MiniAppContextReader = () => Promise<MiniAppContext | null>

type MiniAppSession = {
  app: MiniAppDefinition | null
  tools: MiniAppTool[]
  invokeTool: MiniAppToolInvoker | null
  requestContext: MiniAppContextReader | null
}

const emptySession: MiniAppSession = { app: null, tools: [], invokeTool: null, requestContext: null }

type MiniAppState = {
  sessions: ReadonlyMap<string, MiniAppSession>
  openApp: (app: MiniAppDefinition, owner: string) => void
  closeApp: (owner: string) => void
  setTools: (tools: MiniAppTool[], invokeTool: MiniAppToolInvoker, owner: string) => void
  setContextReader: (requestContext: MiniAppContextReader, owner: string) => void
  resetGuest: (owner: string) => void
}

/** Each mounted remote frame owns its tools; late replies cannot overwrite another frame. */
export const useMiniAppStore = create<MiniAppState>((set, get) => {
  const update = (owner: string, patch: Partial<MiniAppSession>) =>
    set((state) => {
      const session = state.sessions.get(owner)
      if (!session) {
        return state
      }
      const sessions = new Map(state.sessions)
      sessions.set(owner, { ...session, ...patch })
      return { sessions }
    })

  const cancelApprovals = (owner: string) => {
    const app = get().sessions.get(owner)?.app
    if (app) {
      useChatStore.getState().cancelMiniAppApprovals(app.id, owner)
    }
  }

  return {
    sessions: new Map(),
    openApp: (app, owner) =>
      set((state) => ({ sessions: new Map(state.sessions).set(owner, { ...emptySession, app }) })),
    closeApp: (owner) => {
      cancelApprovals(owner)
      set((state) => {
        if (!state.sessions.has(owner)) {
          return state
        }
        const sessions = new Map(state.sessions)
        sessions.delete(owner)
        return { sessions }
      })
    },
    setTools: (tools, invokeTool, owner) => update(owner, { tools, invokeTool }),
    setContextReader: (requestContext, owner) => update(owner, { requestContext }),
    resetGuest: (owner) => {
      cancelApprovals(owner)
      update(owner, { tools: [], invokeTool: null, requestContext: null })
    },
  }
})

/** A closed frame always returns an empty snapshot, including to an in-flight turn. */
export const getMiniAppSnapshot = (owner: string | null): MiniAppSession =>
  (owner ? useMiniAppStore.getState().sessions.get(owner) : null) ?? emptySession

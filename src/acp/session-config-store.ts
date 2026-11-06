/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk'

export type SessionConfigState = {
  options: SessionConfigOption[]
  setOption: (configId: string, value: string) => Promise<void>
}

/** A connection generation owns its entries; a stale disconnect must not clear its successor. */
export const useSessionConfigStore = create<{
  sessions: Map<string, SessionConfigState>
  set: (key: string, state: SessionConfigState) => void
  remove: (key: string, setOption: SessionConfigState['setOption']) => void
}>((set) => ({
  sessions: new Map(),
  set: (key, state) => set((previous) => ({ sessions: new Map(previous.sessions).set(key, state) })),
  remove: (key, setOption) =>
    set((previous) => {
      if (previous.sessions.get(key)?.setOption !== setOption) {
        return previous
      }
      const sessions = new Map(previous.sessions)
      sessions.delete(key)
      return { sessions }
    }),
}))

/** Agent and thread jointly own configuration, unlike agent-wide slash commands. */
export const sessionConfigKey = (agentId: string, threadId: string): string => `${agentId}:${threadId}`

/** Preserve opaque ACP values and the agent's ordering, including grouped choices. */
export const configSelectOptions = (option: SessionConfigOption): SessionConfigSelectOption[] =>
  option.type === 'select' ? option.options.flatMap((item) => ('group' in item ? item.options : [item])) : []

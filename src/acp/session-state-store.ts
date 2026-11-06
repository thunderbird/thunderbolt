/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import type { AcpContextUsage } from './compaction'
import type { AcpCommand } from './translators/acp-to-ai-sdk'

export type AcpSessionState = {
  sessionId: string
  commands: AcpCommand[]
  usage?: AcpContextUsage
}

/** Session capabilities and live usage belong to one connection generation. */
export const useAcpSessionStore = create<{
  sessions: Map<string, AcpSessionState>
  owners: Map<string, object>
  set: (key: string, state: AcpSessionState, owner: object) => void
  remove: (key: string, owner: object) => void
}>((set) => ({
  sessions: new Map(),
  owners: new Map(),
  set: (key, state, owner) =>
    set((previous) => ({
      sessions: new Map(previous.sessions).set(key, state),
      owners: new Map(previous.owners).set(key, owner),
    })),
  remove: (key, owner) =>
    set((previous) => {
      if (previous.owners.get(key) !== owner) {
        return previous
      }
      const sessions = new Map(previous.sessions)
      const owners = new Map(previous.owners)
      sessions.delete(key)
      owners.delete(key)
      return { sessions, owners }
    }),
}))

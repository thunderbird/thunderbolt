/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'

export type ArtifactSession = {
  owner: string
  artifactId: string
  kind: 'html' | 'remote'
  inline: boolean
  /** Zero until explicitly activated; mounted inline previews must not steal focus. */
  activated: number
}

type ArtifactSessionState = {
  sessions: ReadonlyMap<string, ArtifactSession>
  sequence: number
  register: (session: Omit<ArtifactSession, 'activated'>) => void
  activate: (owner: string) => void
  unregister: (owner: string) => void
}

/** Choose the last focused mounted surface, falling back to the latest inline artifact. */
export const selectArtifactSession = (sessions: ReadonlyMap<string, ArtifactSession>): ArtifactSession | null =>
  [...sessions.values()].reduce<ArtifactSession | null>(
    (active, session) => (!active || session.activated >= active.activated ? session : active),
    null,
  )

/** Mounted surface ownership is independent of where an artifact is displayed or stored. */
export const useArtifactSessionStore = create<ArtifactSessionState>((set) => ({
  sessions: new Map(),
  sequence: 0,
  register: (session) =>
    set((state) => {
      const sequence = state.sequence + 1
      const sessions = new Map(state.sessions)
      sessions.set(session.owner, { ...session, activated: session.inline ? 0 : sequence })
      return { sessions, sequence }
    }),
  activate: (owner) =>
    set((state) => {
      const session = state.sessions.get(owner)
      if (!session) {
        return state
      }
      const sequence = state.sequence + 1
      const sessions = new Map(state.sessions)
      sessions.set(owner, { ...session, activated: sequence })
      return { sessions, sequence }
    }),
  unregister: (owner) =>
    set((state) => {
      if (!state.sessions.has(owner)) {
        return state
      }
      const sessions = new Map(state.sessions)
      sessions.delete(owner)
      return { sessions }
    }),
}))

/** Read one consistent active owner outside React while assembling an agent turn. */
export const getActiveArtifactSession = (): ArtifactSession | null =>
  selectArtifactSession(useArtifactSessionStore.getState().sessions)

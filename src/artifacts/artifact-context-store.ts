/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ArtifactContext } from '@/artifacts/harness'
import { create } from 'zustand'

export type ArtifactContextSnapshot = { title: string | null; context: ArtifactContext | null }
const emptyContext: ArtifactContextSnapshot = { title: null, context: null }

type ArtifactContextState = {
  sessions: ReadonlyMap<string, ArtifactContextSnapshot>
  openArtifact: (title: string, owner: string) => void
  renameArtifact: (title: string, owner: string) => void
  setContext: (context: ArtifactContext, owner: string) => void
  closeArtifact: (owner: string) => void
}

/** Context belongs to a mounted HTML frame, never whichever frame happened to report last. */
export const useArtifactContextStore = create<ArtifactContextState>((set) => ({
  sessions: new Map(),
  openArtifact: (title, owner) =>
    set((state) => ({ sessions: new Map(state.sessions).set(owner, { title, context: null }) })),
  renameArtifact: (title, owner) =>
    set((state) => {
      const session = state.sessions.get(owner)
      if (!session || session.title === title) {
        return state
      }
      return { sessions: new Map(state.sessions).set(owner, { ...session, title }) }
    }),
  setContext: (context, owner) =>
    set((state) => {
      const session = state.sessions.get(owner)
      if (!session) {
        return state
      }
      return { sessions: new Map(state.sessions).set(owner, { ...session, context }) }
    }),
  closeArtifact: (owner) =>
    set((state) => {
      if (!state.sessions.has(owner)) {
        return state
      }
      const sessions = new Map(state.sessions)
      sessions.delete(owner)
      return { sessions }
    }),
}))

/** Read the selected frame only; a removed owner cannot expose a different artifact's context. */
export const getArtifactContextSnapshot = (owner: string | null): ArtifactContextSnapshot =>
  (owner ? useArtifactContextStore.getState().sessions.get(owner) : null) ?? emptyContext

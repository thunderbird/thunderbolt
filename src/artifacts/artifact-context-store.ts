/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * What the open artifact is showing, for the model to read.
 *
 * Mirrors `mini-app-store.ts` on purpose: both surfaces publish upward, the
 * host caches the last thing it heard, and `get_app_context` serves whichever
 * one is open. The user asks "what does this show?" about a rectangle on their
 * screen and shouldn't have to know which kind it is.
 *
 * Registered only while the artifact panel is open, and cleared on close — a
 * stale context outliving its panel would have the model confidently describing
 * something the user can no longer see.
 */

import type { ArtifactContext } from '@/artifacts/harness'
import { create } from 'zustand'

type ArtifactContextState = {
  /** Title of the open artifact, or null when no panel is open. */
  title: string | null
  /** The last context the page published. Null until it reports one. */
  context: ArtifactContext | null
  openArtifact: (title: string) => void
  setContext: (context: ArtifactContext) => void
  closeArtifact: () => void
}

export const useArtifactContextStore = create<ArtifactContextState>((set) => ({
  title: null,
  context: null,
  // Clears any previous context: opening a second artifact must not inherit the
  // first one's description while the new page is still loading.
  openArtifact: (title) => set({ title, context: null }),
  setContext: (context) => set({ context }),
  closeArtifact: () => set({ title: null, context: null }),
}))

/** Read outside React — the tool layer runs beyond the component tree. */
export const getArtifactContextSnapshot = (): { title: string | null; context: ArtifactContext | null } => {
  const { title, context } = useArtifactContextStore.getState()
  return { title, context }
}

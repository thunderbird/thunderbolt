/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useIsMobile } from '@/hooks/use-mobile'
import { useCallback } from 'react'
import { create } from 'zustand'
import type { ArtifactTarget } from './render-html-tool'

type ArtifactTargetStore = {
  targets: Record<string, ArtifactTarget>
  setTarget: (artifactId: string, target: ArtifactTarget) => void
}

/**
 * Per-artifact render-target overrides (inline vs side panel), keyed by the
 * render_html tool-call id. Ephemeral UI state — the artifact HTML itself lives
 * in the persisted message, so nothing here needs to survive a reload.
 */
const useArtifactTargetStore = create<ArtifactTargetStore>((set) => ({
  targets: {},
  setTarget: (artifactId, target) => set((state) => ({ targets: { ...state.targets, [artifactId]: target } })),
}))

/**
 * Resolve an artifact's current render target: a user override if one exists,
 * otherwise the agent's chosen `fallback`. The side panel does not exist on
 * mobile, so inline is always used there.
 */
export const useArtifactTarget = (artifactId: string, fallback: ArtifactTarget) => {
  const stored = useArtifactTargetStore((state) => state.targets[artifactId])
  const setStored = useArtifactTargetStore((state) => state.setTarget)
  const { isMobile } = useIsMobile()
  const target: ArtifactTarget = isMobile ? 'inline' : (stored ?? fallback)
  const setTarget = useCallback((next: ArtifactTarget) => setStored(artifactId, next), [artifactId, setStored])
  return { target, setTarget }
}

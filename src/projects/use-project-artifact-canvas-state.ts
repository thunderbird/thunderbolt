/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useArtifactContextStore } from '@/artifacts/artifact-context-store'
import type { ArtifactContext } from '@/artifacts/harness'

/** Publish the visible canvas to the agent, yielding ownership while another content panel is open. */
export const useProjectArtifactCanvasState = (html: string, title: string, active: boolean) => {
  const [document, setDocument] = useState({ html, error: null as string | null })
  const contextRef = useRef<ArtifactContext | null>(null)
  if (document.html !== html) {
    setDocument({ html, error: null })
    contextRef.current = null
  }
  useEffect(() => {
    if (!active) {
      return
    }
    const store = useArtifactContextStore.getState()
    store.openArtifact(title)
    if (contextRef.current) {
      store.setContext(contextRef.current)
    }
    return store.closeArtifact
  }, [title, html, active])
  const onContextChange = useCallback(
    (context: ArtifactContext) => {
      contextRef.current = context
      if (active) {
        useArtifactContextStore.getState().setContext(context)
      }
    },
    [active],
  )
  const onError = (error: string) => setDocument({ html, error })
  return { error: document.error, onError, onContextChange }
}

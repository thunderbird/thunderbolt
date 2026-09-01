/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ArtifactActions } from '@/components/artifact/artifact-actions'
import { EmbeddedErrorStrip } from '@/components/embedded/surface-status'
import { SelectableArtifact } from '@/components/artifact/selectable-artifact'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'
import { useParams } from 'react-router'
import { useArtifactContextStore } from '@/artifacts/artifact-context-store'
import { useEffect, useRef, useState } from 'react'
import { type ArtifactViewData } from './context'
import { ContentViewHeader } from './header'

type ArtifactSidebarContentProps = {
  data: ArtifactViewData
  onClose: () => void
}

/**
 * Side-panel view for a verified HTML artifact. Reuses the shared content-view
 * chrome; closing the panel returns the artifact inline in the transcript (they
 * are two sides of one toggle — it is only ever shown in one place at a time).
 * Post-load runtime errors surface as a strip here too, matching the inline card.
 */
export const ArtifactSidebarContent = ({ data, onClose }: ArtifactSidebarContentProps) => {
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  // The artifact was produced by the chat this panel is open beside, so its
  // quotes belong on that thread's composer — no session to mint, unlike a Mini
  // App, which may be opened with no chat in play at all.
  const { chatThreadId } = useParams()

  /*
   * Register the open artifact so `get_app_context` can describe it.
   *
   * An effect because it's a subscription to something outside React that must
   * be torn down: a context outliving its panel would have the model describing
   * a surface the user already closed.
   */
  const openArtifact = useArtifactContextStore((state) => state.openArtifact)
  const closeArtifact = useArtifactContextStore((state) => state.closeArtifact)
  const setArtifactContext = useArtifactContextStore((state) => state.setContext)
  useEffect(() => {
    openArtifact(data.title)
    return closeArtifact
  }, [data.title, openArtifact, closeArtifact])
  const askAbout = (passages: string[]) => {
    if (!chatThreadId) {
      return
    }
    const { addQuote } = usePendingQuotesStore.getState()
    for (const text of passages) {
      addQuote(chatThreadId, { text })
    }
  }
  // Clear a stale error only at a reload boundary (a new document). Clearing on `ready` instead
  // would wipe an error the harness reports during initial load — it fires before `ready`, so the
  // user would never see it. Adjusting state during render is the React-blessed reset-on-prop-change.
  const lastHtmlRef = useRef(data.html)
  if (lastHtmlRef.current !== data.html) {
    lastHtmlRef.current = data.html
    setRuntimeError(null)
  }
  return (
    <div
      className="flex h-dvh flex-col md:pt-[var(--safe-area-top-padding)]"
      style={{ paddingBottom: 'var(--safe-area-bottom-padding)' }}
    >
      <ContentViewHeader
        title={data.title}
        onClose={onClose}
        className="md:bg-card"
        actions={<ArtifactActions html={data.html} title={data.title} />}
      />
      {runtimeError && <EmbeddedErrorStrip message={runtimeError} />}
      <div className="min-h-0 flex-1 bg-white">
        <SelectableArtifact
          html={data.html}
          title={data.title}
          onError={setRuntimeError}
          onAsk={askAbout}
          onContextChange={setArtifactContext}
        />
      </div>
    </div>
  )
}

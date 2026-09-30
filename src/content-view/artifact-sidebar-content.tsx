/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ArtifactActions } from '@/components/artifact/artifact-actions'
import { EmbeddedErrorStrip } from '@/components/embedded'
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
  /*
   * The thread a highlighted passage belongs to.
   *
   * `data.chatThreadId` first, because the view carries the conversation that
   * produced the artifact. The route param is the fallback for any caller that
   * does not: on `/chats/:id` the two agree, and on `/apps/:appId` there is no
   * param at all — its conversation is held by the Mini App panel — which is
   * why deriving this from the route alone dropped every passage picked out of
   * an artifact opened beside an app, and warned about a missing composer while
   * a real one was open.
   */
  const { chatThreadId: routeChatThreadId } = useParams()
  const chatThreadId = data.chatThreadId ?? routeChatThreadId ?? null

  /*
   * Register the open artifact so `get_app_context` can describe it.
   *
   * An effect because it writes to a store outside React and the write must be
   * undone: a context outliving its panel would have the model describing a
   * surface the user already closed. Not a subscription — nothing flows back.
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
      // No conversation anywhere: the artifact was opened without one and the
      // route has none either. Logged because from the user's side this is
      // indistinguishable from the gesture being broken — they picked something
      // and nothing happened.
      console.warn('[artifacts] Nothing to attach the passage to — no conversation for this artifact')
      return
    }
    const { addQuote } = usePendingQuotesStore.getState()
    for (const text of passages) {
      addQuote(chatThreadId, { text })
    }
    /*
     * Step out of the way when the composer is not on screen.
     *
     * On `/chats/:id` the transcript is right there and closing would be
     * obstructive. On `/apps/:appId` this panel occupies the slot the Mini App
     * chat panel uses, so the quote would sit in a composer the user cannot
     * see. Closing hands the slot back; the passage is already attached and
     * waiting when they reopen the chat.
     */
    if (!routeChatThreadId) {
      onClose()
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

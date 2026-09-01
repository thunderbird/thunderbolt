/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  artifactRequest,
  artifactSelectionItemsSchema,
  artifactSelectionQueryMethod,
  formatHarnessError,
  parseHarnessMessage,
  wrapArtifactHtml,
  wrapArtifactPreviewHtml,
  type ArtifactContext,
  type ArtifactSelectionItem,
  type ArtifactTextSelection,
} from '@/artifacts/harness'
import { createPendingRequests } from '@/components/embedded/pending-requests'
import type { SurfaceRect } from '@/components/embedded/types'
import { cn } from '@/lib/utils'
import { useEffect, useMemo, useRef, useState } from 'react'

/** Height used before the page reports its own, and the floor/ceiling for the reported height. */
const defaultAutoHeightPx = 400
const minAutoHeightPx = 60
// Ceiling so a page (which knows its own nonce) can't report a huge height and blow out the transcript.
const maxAutoHeightPx = 20_000
/**
 * How long to wait for an artifact to resolve a marquee.
 *
 * Generous, because the page is doing DOM work on a drag the user just
 * finished; short enough that a page which threw before registering its handler
 * doesn't leave the confirm bar hanging.
 */
const selectionQueryTimeoutMs = 2_000

export type SandboxedHtmlFrameProps = {
  /** Complete, self-contained HTML document to render. */
  html: string
  /** Accessible title for the iframe. */
  title: string
  className?: string
  /**
   * Whether the page's own scripts may run. Defaults to `true`. Set `false` for a
   * live streaming preview so incomplete/complete JS never executes (no hangs, no
   * spurious errors) — only HTML/CSS render. No harness is injected in that mode.
   */
  allowScripts?: boolean
  /**
   * Size the iframe to its content's height (reported by the harness) instead of
   * filling its container — so a tall artifact grows the card rather than scrolling
   * inside a fixed frame (which would trap the page scroll). Needs `allowScripts`.
   */
  autoHeight?: boolean
  /** Fired once the page has loaded and run its initial synchronous script. */
  onReady?: () => void
  /** Fired if the page reports a runtime error (including after load, during use). */
  onError?: (error: string) => void
  /**
   * Fired when the user highlights text inside the artifact, and again with null
   * when they clear it. Reported by the page because the host cannot read a
   * selection inside a frame it shares no origin with.
   */
  onSelectionChange?: (selection: ArtifactTextSelection | null) => void
  /**
   * Receives a resolver for marquee selection: hand it a rect in the artifact's
   * own viewport coordinates and it answers with what that rect covers.
   *
   * Passed out rather than exposed on a ref because the nonce and the frame
   * element are both private to this component, and the caller only ever needs
   * the one question.
   */
  onQueryReady?: (query: (rect: SurfaceRect) => Promise<ArtifactSelectionItem[]>) => void
  /**
   * What the page currently shows, derived by the harness and re-sent when the
   * page changes — so an artifact the user has interacted with reports what it
   * looks like now, not what it looked like at load.
   */
  onContextChange?: (context: ArtifactContext) => void
}

/**
 * Renders agent-authored HTML inside a sandboxed iframe (`allow-scripts`, and
 * deliberately no `allow-same-origin`, so it cannot reach the parent's DOM,
 * cookies, or storage). The HTML is wrapped with the same harness used for
 * verification, so a page that throws during use is surfaced via `onError` —
 * and what we show is exactly what we verified. Shared by the inline and
 * side-panel artifact views.
 */
export const SandboxedHtmlFrame = ({
  html,
  title,
  className,
  allowScripts = true,
  autoHeight = false,
  onReady,
  onError,
  onSelectionChange,
  onQueryReady,
  onContextChange,
}: SandboxedHtmlFrameProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // One nonce per mounted frame; correlates the harness's messages with this iframe. useState (not
  // useMemo) so it's a real stability guarantee — React may drop a useMemo cache and recompute,
  // which would regenerate the nonce, silently reload the iframe, and re-key the message listener.
  const [nonce] = useState(() => crypto.randomUUID())
  // Scripts on: wrap with the harness. Scripts off (streaming preview): still inject the
  // offline CSP so the preview can't beacon out via a subresource before verification.
  const srcDoc = useMemo(
    () => (allowScripts ? wrapArtifactHtml(html, nonce) : wrapArtifactPreviewHtml(html)),
    [html, nonce, allowScripts],
  )
  const [contentHeight, setContentHeight] = useState<number | null>(null)
  // Reset the measured height at each reload boundary (new document): without this a
  // streaming→active swap or a document change keeps the previous artifact's height until a fresh
  // `artifact-height` arrives, leaving dead space or clipping. Adjusting state during render (per
  // the React docs' "storing information from previous renders") beats an effect for a pure reset.
  const lastSrcDocRef = useRef(srcDoc)
  if (lastSrcDocRef.current !== srcDoc) {
    lastSrcDocRef.current = srcDoc
    setContentHeight(null)
  }

  // Keep the latest callbacks in refs so the message subscription is set up once
  // per document, not re-subscribed on every parent render.
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const onSelectionChangeRef = useRef(onSelectionChange)
  onSelectionChangeRef.current = onSelectionChange
  const onContextChangeRef = useRef(onContextChange)
  onContextChangeRef.current = onContextChange

  /**
   * Hand the caller a marquee resolver, once per document.
   *
   * Bound to this render's nonce so a resolver captured before a reload can't
   * be answered by the new document — a stale query resolves empty instead of
   * returning the previous artifact's rows.
   */
  const onQueryReadyRef = useRef(onQueryReady)
  onQueryReadyRef.current = onQueryReady
  // One registry per frame, shared with the message handler below so replies
  // route through a single listener rather than one per request.
  const [pending] = useState(() => createPendingRequests())
  useEffect(() => {
    onQueryReadyRef.current?.(async (rect) => {
      const frame = iframeRef.current?.contentWindow
      if (!frame) {
        return []
      }
      const result = await pending.issue(
        (id) => frame.postMessage(artifactRequest(nonce, id, artifactSelectionQueryMethod, { rect }), '*'),
        selectionQueryTimeoutMs,
      )
      // Parsed rather than cast: `Array.isArray` said nothing about the elements,
      // so a page answering with `[{}]` rendered `undefined` into a composer chip.
      // Anything unexpected resolves empty, which is this path's documented
      // fallback everywhere else.
      const parsed = artifactSelectionItemsSchema.safeParse(result)
      return parsed.success ? parsed.data.items : []
    })
  }, [nonce, pending])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = parseHarnessMessage(event, iframeRef.current?.contentWindow ?? null, nonce)
      if (!data) {
        return
      }
      if (data.type === 'artifact-ready') {
        onReadyRef.current?.()
      }
      if (data.type === 'artifact-error') {
        onErrorRef.current?.(formatHarnessError(data))
      }
      if (data.type === 'artifact-selection') {
        onSelectionChangeRef.current?.(data.selection)
      }
      if (data.type === 'artifact-context') {
        onContextChangeRef.current?.(data.context)
      }
      if (data.type === 'artifact-reply') {
        pending.settle(data.id, data.result)
      }
      if (data.type === 'artifact-height' && Number.isFinite(data.height)) {
        const next = Math.min(maxAutoHeightPx, Math.max(minAutoHeightPx, Math.round(data.height)))
        // Ignore sub-pixel jitter so a self-measuring page can't oscillate.
        setContentHeight((prev) => (prev !== null && Math.abs(prev - next) <= 1 ? prev : next))
      }
    }
    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
      // A caller awaiting an answer when the document reloads gets an empty one
      // rather than a promise that never settles.
      pending.abortAll()
    }
  }, [nonce, pending])

  return (
    <iframe
      ref={iframeRef}
      title={title}
      sandbox={allowScripts ? 'allow-scripts' : ''}
      srcDoc={srcDoc}
      style={autoHeight ? { height: contentHeight ?? defaultAutoHeightPx } : undefined}
      className={cn('w-full border-0 bg-white', autoHeight ? '' : 'h-full', className)}
    />
  )
}

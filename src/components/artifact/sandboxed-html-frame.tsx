/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { formatHarnessError, parseHarnessMessage, wrapArtifactHtml, wrapArtifactPreviewHtml } from '@/artifacts/harness'
import { cn } from '@/lib/utils'
import { useEffect, useMemo, useRef, useState } from 'react'

/** Height used before the page reports its own, and the floor/ceiling for the reported height. */
const defaultAutoHeightPx = 400
const minAutoHeightPx = 60
// Ceiling so a page (which knows its own nonce) can't report a huge height and blow out the transcript.
const maxAutoHeightPx = 20_000

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
      if (data.type === 'artifact-height' && Number.isFinite(data.height)) {
        const next = Math.min(maxAutoHeightPx, Math.max(minAutoHeightPx, Math.round(data.height)))
        // Ignore sub-pixel jitter so a self-measuring page can't oscillate.
        setContentHeight((prev) => (prev !== null && Math.abs(prev - next) <= 1 ? prev : next))
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [nonce])

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

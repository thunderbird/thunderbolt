/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { artifactRequest, formatHarnessError, wrapArtifactHtml, wrapArtifactPreviewHtml } from '@/artifacts/harness'
import { bindArtifactChannel } from '@/artifacts/channel'
import { createPendingRequests } from '@/components/embedded'

import { cn } from '@/lib/utils'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'

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
  onHeightChange?: (height: number) => void
  onRequestReady?: (request: ((method: string, params: unknown) => Promise<unknown>) | null) => void
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
  onHeightChange,
  onRequestReady,
  onError,
}: SandboxedHtmlFrameProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // WindowProxy identity survives iframe navigation. Rotate the nonce with each
  // document so queued messages from its predecessor cannot initialize this one.
  const [renderedDocument, setDocument] = useState(() => ({ html, allowScripts, nonce: crypto.randomUUID() }))
  if (renderedDocument.html !== html || renderedDocument.allowScripts !== allowScripts) {
    setDocument({ html, allowScripts, nonce: crypto.randomUUID() })
  }
  const nonce = renderedDocument.nonce
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
  const heightCallback = useRef(onHeightChange)
  heightCallback.current = onHeightChange
  const requestCallback = useRef(onRequestReady)
  requestCallback.current = onRequestReady
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const pendingRef = useRef<ReturnType<typeof createPendingRequests> | null>(null)
  pendingRef.current ??= createPendingRequests()
  const pending = pendingRef.current

  // The first srcdoc script bootstraps its channel before load. Subscribe during
  // commit, before the browser can run that script, rather than in a passive effect.
  useLayoutEffect(() => {
    let current = true
    let ready = false
    const channel = bindArtifactChannel({
      getFrameWindow: () => iframeRef.current?.contentWindow ?? null,
      nonce,
      onMessage: (data) => {
        if (data.type === 'artifact-ready' && !ready) {
          ready = true
          requestCallback.current?.(async (method, params) => {
            if (!current) {
              throw new Error('The page document changed. Observe it again.')
            }
            return pending.issue((id) => channel.send(artifactRequest(nonce, id, method, params)), 5000)
          })
          onReadyRef.current?.()
        }
        if (data.type === 'artifact-error') {
          onErrorRef.current?.(formatHarnessError(data))
        }
        if (data.type === 'artifact-reply') {
          pending.settle(data.id, data.result)
        }
        if (data.type === 'artifact-height' && Number.isFinite(data.height)) {
          const next = Math.min(maxAutoHeightPx, Math.max(minAutoHeightPx, Math.round(data.height)))
          heightCallback.current?.(next)
          // Ignore sub-pixel jitter so a self-measuring page can't oscillate.
          setContentHeight((prev) => (prev !== null && Math.abs(prev - next) <= 1 ? prev : next))
        }
      },
      onClose: () => {
        current = false
        requestCallback.current?.(null)
        pending.abortAll()
      },
    })
    return channel.close
  }, [nonce, srcDoc, pending])

  return (
    <iframe
      ref={iframeRef}
      title={title}
      sandbox={allowScripts ? 'allow-scripts' : ''}
      srcDoc={srcDoc}
      style={autoHeight ? { height: contentHeight ?? defaultAutoHeightPx } : undefined}
      // White like a browser page: the HTML assumes it, whatever the app theme.
      className={cn('w-full border-0 bg-white', autoHeight ? '' : 'h-full', className)}
    />
  )
}

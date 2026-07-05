/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { formatHarnessError, parseHarnessMessage, wrapArtifactHtml } from '@/artifacts/harness'
import { cn } from '@/lib/utils'
import { useEffect, useMemo, useRef } from 'react'

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
  onReady,
  onError,
}: SandboxedHtmlFrameProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // One nonce per mounted frame; correlates the harness's messages with this iframe.
  const nonce = useMemo(() => crypto.randomUUID(), [])
  // With scripts on, wrap with the harness; with scripts off (preview) render raw HTML/CSS.
  const srcDoc = useMemo(() => (allowScripts ? wrapArtifactHtml(html, nonce) : html), [html, nonce, allowScripts])

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
      className={cn('h-full w-full border-0 bg-white', className)}
    />
  )
}

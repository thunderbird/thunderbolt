/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { formatHarnessError, parseHarnessMessage, wrapArtifactHtml } from './harness'
import { type StaticIssue, staticCheckHtml } from './static-check'

/** Outcome of verifying an agent-authored HTML artifact. `errors` is empty when `ok`. */
export type ArtifactVerifyResult = {
  ok: boolean
  errors: string[]
}

/** Injectable seam so the composition can be unit-tested without a real iframe. */
export type RuntimeVerifier = (html: string, opts?: { timeoutMs?: number }) => Promise<ArtifactVerifyResult>

export type VerifyOptions = {
  timeoutMs?: number
  /** Override the runtime pass (tests inject a stub). Defaults to the hidden-iframe check. */
  runtime?: RuntimeVerifier
  /** Skip the runtime iframe pass entirely (e.g. a non-DOM context). Static checks still run. */
  skipRuntime?: boolean
}

const defaultTimeoutMs = 4000
const readyGraceMs = 250

const formatStaticIssue = (issue: StaticIssue): string => {
  if (issue.source === 'resource') {
    return issue.message
  }
  const location = issue.line ? ` (line ${issue.line}${issue.column ? `:${issue.column}` : ''})` : ''
  return `Invalid ${issue.source.toUpperCase()}${location}: ${issue.message}`
}

/**
 * Runtime-verify by mounting the wrapped HTML in a hidden, sandboxed iframe and
 * listening for the harness's `ready`/`error` postMessages. Resolves `ok: false`
 * on the first reported error, on a failed load, or on a hard timeout (a hang or
 * a page that never finishes loading). Browser-only — requires a real `document`.
 */
export const runIframeVerification: RuntimeVerifier = (html, opts) =>
  new Promise((resolve) => {
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs
    const nonce = crypto.randomUUID()

    const iframe = document.createElement('iframe')
    iframe.setAttribute('sandbox', 'allow-scripts') // never combine with allow-same-origin
    iframe.setAttribute('aria-hidden', 'true')
    iframe.style.cssText = 'position:fixed;left:-99999px;top:0;width:1024px;height:768px;border:0;visibility:hidden;'

    let settled = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      window.removeEventListener('message', onMessage)
      clearTimeout(hardTimer)
      clearTimeout(graceTimer)
      iframe.remove()
    }
    const finish = (result: ArtifactVerifyResult) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(result)
    }

    const onMessage = (event: MessageEvent) => {
      const data = parseHarnessMessage(event, iframe.contentWindow, nonce)
      if (!data) {
        return
      }
      if (data.type === 'artifact-error') {
        finish({ ok: false, errors: [formatHarnessError(data)] })
        return
      }
      if (data.type === 'artifact-ready') {
        // Handle only the FIRST ready: cancel the hard timeout and open a short grace window
        // for a late async error. Ignoring repeat 'ready' messages avoids stacking grace timers
        // and — since the hard timer is now gone — stops a page deferring completion forever by
        // re-sending 'ready'.
        if (graceTimer === undefined) {
          clearTimeout(hardTimer)
          graceTimer = setTimeout(() => finish({ ok: true, errors: [] }), readyGraceMs)
        }
      }
      // artifact-height messages are ignored — verification only cares about ready/error.
    }

    // NOTE: this only guards ASYNC hangs / never-renders. A sandboxed srcdoc iframe shares the
    // parent's main thread, so a SYNCHRONOUS infinite loop (`while (true) {}`) blocks the event
    // loop and this timer can't fire — verification would hang. True isolation needs a Worker or
    // cross-origin OOPIF; accepted for now since artifacts are model-authored, not adversarial.
    const hardTimer = setTimeout(
      () =>
        finish({
          ok: false,
          errors: ['Timed out waiting for the page to load (it never rendered or an async task never settled).'],
        }),
      timeoutMs,
    )

    window.addEventListener('message', onMessage)
    iframe.srcdoc = wrapArtifactHtml(html, nonce)
    document.body.appendChild(iframe)
  })

/**
 * Verify an agent-authored, self-contained HTML artifact actually works:
 * a fast static JS/CSS syntax pre-check, then a runtime pass that renders the
 * page in a hidden sandboxed iframe and watches for uncaught errors, unhandled
 * rejections, and failed resource loads. Returns `{ ok, errors }`; the errors
 * are phrased to hand straight back to the agent for self-correction.
 */
export const verifyArtifactHtml = async (html: string, options: VerifyOptions = {}): Promise<ArtifactVerifyResult> => {
  const staticIssues = await staticCheckHtml(html)
  if (staticIssues.length > 0) {
    return { ok: false, errors: staticIssues.map(formatStaticIssue) }
  }

  if (options.skipRuntime) {
    return { ok: true, errors: [] }
  }

  const runtime = options.runtime ?? runIframeVerification
  return runtime(html, { timeoutMs: options.timeoutMs })
}

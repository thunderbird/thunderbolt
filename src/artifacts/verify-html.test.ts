/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'
import { runIframeVerification, verifyArtifactHtml } from './verify-html'

const validHtml = '<!doctype html><html><head></head><body><h1>ok</h1></body></html>'

describe('verifyArtifactHtml', () => {
  it('short-circuits on a static syntax error without running the iframe pass', async () => {
    const runtime = mock(async () => ({ ok: true, errors: [] }))
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag -- test literal, not a DOM sink; the real path renders in a sandboxed iframe.
    const result = await verifyArtifactHtml('<script>const x = ;</script>', { runtime })
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('Invalid JS')
    expect(runtime).not.toHaveBeenCalled()
  })

  it('runs the runtime pass when static checks pass and returns its result', async () => {
    const runtime = mock(async () => ({ ok: false, errors: ['Uncaught error: boom'] }))
    const result = await verifyArtifactHtml(validHtml, { runtime })
    expect(runtime).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: false, errors: ['Uncaught error: boom'] })
  })

  it('passes when static checks pass and the runtime reports no errors', async () => {
    const runtime = mock(async () => ({ ok: true, errors: [] }))
    expect(await verifyArtifactHtml(validHtml, { runtime })).toEqual({ ok: true, errors: [] })
  })

  it('skips the runtime pass when asked, still returning static failures', async () => {
    expect(await verifyArtifactHtml(validHtml, { skipRuntime: true })).toEqual({ ok: true, errors: [] })
    const bad = await verifyArtifactHtml('<style>h1 color: red }</style>', { skipRuntime: true })
    expect(bad.ok).toBe(false)
  })
})

describe('runIframeVerification', () => {
  // The success/error postMessage path is exercised by driving the real app;
  // happy-dom does not faithfully run scripts inside a sandboxed srcdoc iframe.
  // Here we deterministically cover the hard-timeout + cleanup branch (the one
  // that guards against a hung/never-rendering page) using fake timers.
  it('fails with a timeout error and removes its iframe when the page never signals ready', async () => {
    const before = document.querySelectorAll('iframe').length
    const promise = runIframeVerification(validHtml, { timeoutMs: 100 })
    // Grace window (250ms) exceeds the timeout, so the hard timeout wins even if
    // the environment happens to post a ready message.
    await getClock().tickAsync(120)
    const result = await promise
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('Timed out')
    expect(document.querySelectorAll('iframe').length).toBe(before)
  })
})

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { bundledRelease, useDownloadState } from './use-download-state'

const originalFetch = globalThis.fetch
const originalTimeout = window.setTimeout
let container: HTMLDivElement
let root: Root
const Harness = () => {
  const { releaseState } = useDownloadState()
  return <p>{releaseState.status === 'ready' ? releaseState.release.version : releaseState.status}</p>
}
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  globalThis.fetch = originalFetch
  window.setTimeout = originalTimeout
})

test('refreshes bundled release data from the website cache', async () => {
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify({ tag_name: 'v0.1.162', draft: false, prerelease: false, assets: [] })),
  ) as unknown as typeof fetch
  await act(async () => root.render(<Harness />))
  expect(container.textContent).toBe('v0.1.162')
  expect(globalThis.fetch).toHaveBeenCalledWith(
    '/downloads/release.json',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  )
})

test('an unavailable website cache retains working bundled installers', async () => {
  globalThis.fetch = mock(async () => new Response('', { status: 403 })) as unknown as typeof fetch
  await act(async () => root.render(<Harness />))
  expect(container.textContent).toBe(bundledRelease.version)
})

test('unmount aborts the in-flight request', async () => {
  const signals: AbortSignal[] = []
  globalThis.fetch = mock(
    (_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = options.signal!
        signals.push(signal)
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
  ) as unknown as typeof fetch
  await act(async () => root.render(<Harness />))
  expect(container.textContent).toBe(bundledRelease.version)
  await act(async () => root.render(null))
  expect(signals[0].aborted).toBe(true)
})

test('a stalled refresh keeps the download button immediately usable', async () => {
  const timeouts: Array<() => void> = []
  window.setTimeout = ((callback: () => void) => {
    timeouts.push(callback)
    return 123
  }) as typeof window.setTimeout
  globalThis.fetch = mock(
    (_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
  ) as unknown as typeof fetch
  await act(async () => root.render(<Harness />))
  await act(async () => timeouts[0]())
  expect(container.textContent).toBe(bundledRelease.version)
})

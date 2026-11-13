/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { renderToString } from 'react-dom/server'
import { render } from '../../../../test/render'
import { detectPlatform, type DownloadRelease } from './downloads'
import { useDownloadState } from './use-download-state'

const built: DownloadRelease = { version: 'v1.0.0', downloads: {} }
const latest: DownloadRelease = { version: 'v2.0.0', downloads: {} }
type Load = (signal: AbortSignal) => Promise<DownloadRelease>

/** Shows what the hook returns: the platform as an attribute, the release's version as text. */
const Probe = ({ load }: { load: Load }) => {
  const { detectedPlatform, release } = useDownloadState(built, load)
  return <output data-platform={detectedPlatform}>{release.version}</output>
}

/** A refresh that settles only when the test says so, or when it is cancelled. */
const pendingLoad = () => {
  const { promise, resolve, reject } = Promise.withResolvers<DownloadRelease>()
  const signals: AbortSignal[] = []
  const load: Load = (signal) => {
    signals.push(signal)
    signal.addEventListener('abort', () => reject(signal.reason))
    return promise
  }
  return { load, resolve, reject, signals }
}

let reported: ReturnType<typeof spyOn<Console, 'error'>>
beforeEach(() => {
  reported = spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => reported.mockRestore())

test('offers the release the page was built with until the latest one arrives', async () => {
  const { load, resolve } = pendingLoad()
  const { container } = render(<Probe load={load} />)
  expect(container.textContent).toBe('v1.0.0')

  await act(async () => resolve(latest))

  expect(container.textContent).toBe('v2.0.0')
})

test("reads the visitor's platform once the page has hydrated, and not on the server", () => {
  const { load } = pendingLoad()

  const { container } = render(<Probe load={load} />)

  expect(container.querySelector('output')?.dataset.platform).toBe(
    detectPlatform(navigator.userAgent, navigator.maxTouchPoints),
  )
  expect(renderToString(<Probe load={load} />)).toBe('<output>v1.0.0</output>')
})

test('keeps offering the built release, and reports why, when the refresh fails', async () => {
  const { load, reject } = pendingLoad()
  const { container } = render(<Probe load={load} />)
  const failure = new Error('Release lookup failed: 503')

  await act(async () => reject(failure))

  expect(container.textContent).toBe('v1.0.0')
  expect(reported.mock.calls).toEqual([['Release refresh failed; offering the built-in release', failure]])
})

test('cancels the refresh when the page goes away, without reporting a failure', async () => {
  const { load, signals } = pendingLoad()
  const { unmount } = render(<Probe load={load} />)

  await act(async () => unmount())

  expect(signals.map((signal) => signal.aborted)).toEqual([true])
  expect(reported).not.toHaveBeenCalled()
})

test('a superseded refresh cannot replace the result of the current refresh', async () => {
  const first = Promise.withResolvers<DownloadRelease>()
  const second = Promise.withResolvers<DownloadRelease>()
  const oldLoad: Load = () => first.promise
  const newLoad: Load = () => second.promise
  const { container, rerender } = render(<Probe load={oldLoad} />)
  rerender(<Probe load={newLoad} />)
  await act(async () => second.resolve(latest))
  await act(async () => first.resolve(built))
  expect(container.textContent).toBe(latest.version)
})

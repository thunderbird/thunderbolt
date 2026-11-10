/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DownloadArrival, getRequestedInstaller } from './download-arrival'
import { installers, releasesUrl } from './downloads'

let container: HTMLDivElement
let root: Root
const originalSearch = Object.getOwnPropertyDescriptor(window.location, 'search')
beforeEach(() => {
  Object.defineProperty(window.location, 'search', { configurable: true, writable: true, value: '' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  if (originalSearch) Object.defineProperty(window.location, 'search', originalSearch)
  else Reflect.deleteProperty(window.location, 'search')
})

test('accepts only known installer IDs in the arrival query', () => {
  for (const installer of installers) {
    expect(getRequestedInstaller(`?installer=${installer.id}`)).toBe(installer)
  }
  for (const search of ['', '?installer=', '?installer=unlisted', '?installer=https://evil.test/file']) {
    expect(getRequestedInstaller(search)).toBeUndefined()
  }
})

test('an arrival provides an explicit retry for the selected installer without restarting it', () => {
  window.location.search = '?installer=mac-intel'
  const assign = spyOn(window.location, 'assign')
  try {
    act(() =>
      root.render(
        <DownloadArrival
          releaseState={{
            status: 'ready',
            release: { version: 'v1', downloads: { 'mac-intel': 'https://example.test/intel.dmg' } },
          }}
        />,
      ),
    )
    expect(container.textContent).toContain('Your download should start shortly.')
    expect(container.querySelector('a')!.getAttribute('href')).toBe('https://example.test/intel.dmg')
    expect(container.querySelector('a')!.textContent).toContain('Download again')
    expect(assign).not.toHaveBeenCalled()
  } finally {
    assign.mockRestore()
  }
})

test('an unavailable release gives a usable fallback instead of a fabricated file URL', () => {
  window.location.search = '?installer=mac-arm'
  act(() => root.render(<DownloadArrival releaseState={{ status: 'failed' }} />))
  expect(container.querySelector('a')!.getAttribute('href')).toBe(releasesUrl)
  expect(container.textContent).toContain('View downloads')
})

test('ordinary visits do not claim to have started a download', () => {
  act(() => root.render(<DownloadArrival releaseState={{ status: 'loading' }} />))
  expect(container.textContent).toBe('')
})

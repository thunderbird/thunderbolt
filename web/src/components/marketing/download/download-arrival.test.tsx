/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import { render } from '../../../../test/render'
import { DownloadArrival } from './download-arrival'
import { latestReleasePage, type DownloadRelease } from './downloads'

const release: DownloadRelease = { version: 'v1.2.3', downloads: { 'mac-intel': 'https://example.test/intel.dmg' } }

/** Render the banner as a visitor arriving at this address sees it. */
const arriveAt = (address: string) => {
  window.history.replaceState(null, '', address)
  return render(<DownloadArrival release={release} />).container
}

afterEach(() => window.history.replaceState(null, '', '/'))

test('offers the installer the address names again, without claiming a download is under way', () => {
  const banner = arriveAt('/download/?installer=mac-intel').querySelector('[role="status"]')

  expect(banner?.textContent).toBe('↓Download didn’t start?Download again ↗')
  expect(banner?.querySelector('a')?.getAttribute('href')).toBe('https://example.test/intel.dmg')
})

test('points at the release page when the release lacks that installer', () => {
  const link = arriveAt('/download/?installer=mac-arm').querySelector('a')

  expect(link?.textContent).toBe('View downloads ↗')
  expect(link?.getAttribute('href')).toBe(latestReleasePage)
})

test.each([
  '/download/',
  '/download/?installer=',
  '/download/?installer=unlisted',
  '/download/?installer=mac-intel-and-more',
  '/download/?installer=https://evil.test/file',
  '/download/?other=mac-intel',
])('shows nothing to a visitor arriving at %s', (address) => {
  expect(arriveAt(address).innerHTML).toBe('')
})

test('is left out of the server-rendered page, which cannot see the address', () => {
  window.history.replaceState(null, '', '/download/?installer=mac-intel')

  expect(renderToString(<DownloadArrival release={release} />)).toBe('')
})

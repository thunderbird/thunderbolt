/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DownloadPicker } from './download-picker'
import { releasesUrl, type DetectedPlatform } from './downloads'
import type { ReleaseState } from './use-download-state'

let container: HTMLDivElement
let root: Root
const ready: ReleaseState = {
  status: 'ready',
  release: {
    version: 'v1',
    downloads: {
      'mac-arm': 'https://example.test/arm.dmg',
      'mac-intel': 'https://example.test/intel.dmg',
      'windows-x64': 'https://example.test/x64.exe',
      'windows-arm': 'https://example.test/arm.exe',
      'linux-appimage': 'https://example.test/app.AppImage',
    },
  },
}
const render = (detectedPlatform: DetectedPlatform, releaseState: ReleaseState = ready) =>
  act(() => root.render(<DownloadPicker detectedPlatform={detectedPlatform} releaseState={releaseState} />))
const href = () => container.querySelector<HTMLAnchorElement>('.spark-button')?.getAttribute('href')

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

test.each([
  ['macos', 'https://example.test/arm.dmg', 'Apple Silicon'],
  ['windows', 'https://example.test/x64.exe', 'Intel / AMD (x64)'],
  ['linux', 'https://example.test/app.AppImage', 'AppImage · x64'],
] as const)(
  'automatically recommends %s with one primary action and disclosed architecture',
  (platform, url, variant) => {
    render(platform)
    expect(href()).toBe(url)
    expect(container.querySelectorAll('.spark-button')).toHaveLength(1)
    expect(container.querySelector('.download-variant')!.textContent).toContain(variant)
    expect(container.querySelector('details')!.open).toBe(false)
    expect(container.querySelector('select')).toBeNull()
    expect(container.querySelector('input')).toBeNull()
  },
)

test('other options expands to direct downloads for alternate chips and operating systems', () => {
  render('macos')
  const details = container.querySelector('details')!
  act(() => container.querySelector('summary')!.click())
  expect(details.open).toBe(true)
  expect(container.querySelector('a[aria-label="Download macOS Intel .dmg"]')!.getAttribute('href')).toBe(
    'https://example.test/intel.dmg',
  )
  expect(container.querySelector('a[aria-label="Download Windows ARM64 .exe"]')!.getAttribute('href')).toBe(
    'https://example.test/arm.exe',
  )
  expect(container.querySelector('a[aria-label="Download Linux AppImage x64"]')!.getAttribute('href')).toBe(
    'https://example.test/app.AppImage',
  )
  act(() => container.querySelector('summary')!.click())
  expect(details.open).toBe(false)
  expect(href()).toBe('https://example.test/arm.dmg')
})

test.each(['ios', 'android', 'unknown'] as const)(
  '%s leads to the web app while retaining collapsed desktop options',
  (platform) => {
    render(platform)
    expect(href()).toBe('https://app.thunderbolt.io/')
    expect(container.querySelector('details')!.open).toBe(false)
    expect(container.querySelector('a[aria-label="Download macOS Intel .dmg"]')).not.toBeNull()
    if (platform !== 'unknown')
      expect(container.querySelector('.download-mobile-note')!.textContent).toContain('coming soon')
  },
)

test('loading is disabled and failures or missing installers lead to a working release page', () => {
  render('macos', { status: 'loading' })
  expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
  render('macos', { status: 'failed' })
  expect(href()).toBe(releasesUrl)
  expect(container.textContent).toContain('View release downloads')
  expect(container.querySelector('[role="status"]')!.textContent).toContain('couldn’t load')
  render('macos', { status: 'ready', release: { version: 'v2', downloads: {} } })
  expect(href()).toBe(releasesUrl)
  expect(container.querySelector('[role="status"]')!.textContent).toContain('isn’t in the latest release')
  expect(container.querySelector('a[aria-label="Find macOS Intel on the release page"]')!.getAttribute('href')).toBe(
    releasesUrl,
  )
})

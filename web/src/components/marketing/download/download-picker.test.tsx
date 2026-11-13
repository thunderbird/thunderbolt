/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { render } from '../../../../test/render'
import { DownloadPicker } from './download-picker'
import { latestReleasePage, type DetectedPlatform, type DownloadRelease } from './downloads'

const release: DownloadRelease = {
  version: 'v1.2.3',
  downloads: {
    'mac-arm': 'https://example.test/arm.dmg',
    'mac-intel': 'https://example.test/intel.dmg',
    'windows-x64': 'https://example.test/x64.exe',
    'windows-arm': 'https://example.test/arm.exe',
    'linux-appimage': 'https://example.test/app.AppImage',
    'linux-deb': 'https://example.test/app.deb',
    'linux-rpm': 'https://example.test/app.rpm',
  },
}
const withoutAppleSilicon: DownloadRelease = { version: 'v1.2.3', downloads: { 'mac-intel': release.downloads['mac-intel'] } }

/** Render the picker and return what a visitor can find in it. */
const renderPicker = (
  detectedPlatform: DetectedPlatform | undefined,
  { offered = release, continueToDownloadPage }: { offered?: DownloadRelease; continueToDownloadPage?: boolean } = {},
) => {
  const { container } = render(
    <DownloadPicker
      detectedPlatform={detectedPlatform}
      release={offered}
      continueToDownloadPage={continueToDownloadPage}
    />,
  )
  const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, ' ').trim()
  const links = [...container.querySelectorAll('a')]
  return {
    /** The link with this accessible name, or whose text starts with it. */
    link: (name: string) =>
      links.find((link) => link.getAttribute('aria-label') === name || text(link)?.startsWith(name)),
    /** The line that opens the other options, which begins with the recommended installer's variant. */
    optionsSummary: text(container.querySelector('summary')),
    mobileNote: text(container.querySelector('.download-mobile-note')),
    status: text(container.querySelector('[role="status"]')),
    text,
  }
}

test.each([
  ['macos', 'Download for macOS ↓', 'https://example.test/arm.dmg', 'Apple Silicon ·Other options'],
  ['windows', 'Download for Windows ↓', 'https://example.test/x64.exe', 'Intel / AMD (x64) ·Other options'],
  ['linux', 'Download for Linux ↓', 'https://example.test/app.AppImage', 'AppImage · x64 ·Other options'],
] as const)('offers a %s visitor their installer and names its variant', (platform, button, href, summary) => {
  const picker = renderPicker(platform)

  expect(picker.text(picker.link('Download for'))).toBe(button)
  expect(picker.link('Download for')?.getAttribute('href')).toBe(href)
  expect(picker.optionsSummary).toBe(summary)
  expect(picker.mobileNote).toBeUndefined()
  expect(picker.status).toBeUndefined()
})

test('offers the release page until the page has hydrated and the platform is known', () => {
  const picker = renderPicker(undefined)

  expect(picker.text(picker.link('Download Thunderbolt'))).toBe('Download Thunderbolt ↓')
  expect(picker.link('Download Thunderbolt')?.getAttribute('href')).toBe(
    'https://github.com/thunderbird/thunderbolt/releases/latest',
  )
  expect(picker.optionsSummary).toBe('Other options')
  expect(picker.mobileNote).toBeUndefined()
})

test.each([
  ['ios', 'iOS and Android apps are coming soon.'],
  ['android', 'iOS and Android apps are coming soon.'],
  ['unknown', undefined],
] as const)('sends a visitor on %s, which has no installer, to the web app', (platform, mobileNote) => {
  const picker = renderPicker(platform, { offered: withoutAppleSilicon })

  expect(picker.text(picker.link('Open Thunderbolt'))).toBe('Open Thunderbolt on the web ↗')
  expect(picker.link('Open Thunderbolt')?.getAttribute('href')).toBe('https://app.thunderbolt.io/')
  expect(picker.optionsSummary).toBe('Other options')
  expect(picker.mobileNote).toBe(mobileNote)
  expect(picker.status).toBeUndefined()
})

test.each([
  ['Download macOS Apple Silicon .dmg', 'Apple Silicon .dmg ↓', 'https://example.test/arm.dmg'],
  ['Download macOS Intel .dmg', 'Intel .dmg ↓', 'https://example.test/intel.dmg'],
  ['Download Windows Intel / AMD (x64) .exe', 'Intel / AMD (x64) .exe ↓', 'https://example.test/x64.exe'],
  ['Download Windows ARM64 .exe', 'ARM64 .exe ↓', 'https://example.test/arm.exe'],
  ['Download Linux AppImage x64', 'AppImage x64 ↓', 'https://example.test/app.AppImage'],
  ['Download Linux Debian / Ubuntu .deb · x64', 'Debian / Ubuntu .deb · x64 ↓', 'https://example.test/app.deb'],
  ['Download Linux Fedora / RPM .rpm · x64', 'Fedora / RPM .rpm · x64 ↓', 'https://example.test/app.rpm'],
])('lists "%s" among the other options, whatever the platform', (name, text, href) => {
  const picker = renderPicker('unknown')

  expect(picker.text(picker.link(name))).toBe(text)
  expect(picker.link(name)?.getAttribute('href')).toBe(href)
})

test('points at the release page, and says so, when the release lacks the visitor’s installer', () => {
  const picker = renderPicker('macos', { offered: withoutAppleSilicon })

  expect(picker.text(picker.link('View release downloads'))).toBe('View release downloads ↗')
  expect(picker.link('View release downloads')?.getAttribute('href')).toBe(latestReleasePage)
  expect(picker.status).toBe('This installer isn’t in the latest release. Check the release page for other options.')
  const missing = picker.link('Find macOS Apple Silicon on the release page')
  expect(picker.text(missing)).toBe('Apple Silicon .dmg ↗')
  expect(missing?.getAttribute('href')).toBe(latestReleasePage)
})

test('links the release notes under the version on offer', () => {
  const picker = renderPicker('macos')

  expect(picker.text(picker.link('v1.2.3'))).toBe('v1.2.3 · Release notes ↗')
  expect(picker.link('v1.2.3')?.getAttribute('href')).toBe(latestReleasePage)
})

test('opens installers in a new tab only where the page continues to the download page', () => {
  const staying = renderPicker('macos', { offered: withoutAppleSilicon })
  const continuing = renderPicker('macos', { offered: withoutAppleSilicon, continueToDownloadPage: true })
  const targets = (picker: typeof staying) =>
    ['Download macOS Intel .dmg', 'Find macOS Apple Silicon on the release page', 'View release downloads'].map(
      (name) => picker.link(name)?.getAttribute('target'),
    )

  expect(targets(staying)).toEqual([null, null, null])
  expect(targets(continuing)).toEqual(['_blank', null, null])
  expect(renderPicker('windows', { continueToDownloadPage: true }).link('Download for')?.getAttribute('target')).toBe(
    '_blank',
  )
})

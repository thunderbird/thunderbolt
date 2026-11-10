/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, mock, test } from 'bun:test'
import { detectPlatform, loadRelease, parseRelease } from './downloads'

const originalFetch = globalThis.fetch
const release = (names: string[]) => ({
  tag_name: 'v0.1.162',
  draft: false,
  prerelease: false,
  assets: names.map((name) => ({ name, state: 'uploaded' })),
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

test.each([
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0, 'macos'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0, 'windows'],
  ['Mozilla/5.0 (X11; Linux x86_64)', 0, 'linux'],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8)', 5, 'android'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5, 'ios'],
  ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', 5, 'ios'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 5, 'ios'],
  ['Mozilla/5.0 (X11; CrOS x86_64 1)', 0, 'unknown'],
  ['', 0, 'unknown'],
] as const)('detects %s without confusing mobile and desktop', (agent, touchPoints, expected) => {
  expect(detectPlatform(agent, touchPoints)).toBe(expected)
})

test('maps actual release filenames to all supported desktop installer choices', () => {
  const parsed = parseRelease(
    release([
      'Thunderbolt_0.1.162_aarch64.dmg',
      'Thunderbolt_0.1.162_x64.dmg',
      'Thunderbolt_0.1.162_x64-setup.exe',
      'Thunderbolt_0.1.162_arm64-setup.exe',
      'Thunderbolt_0.1.162_amd64.AppImage',
      'Thunderbolt_0.1.162_amd64.deb',
      'Thunderbolt-0.1.162-1.x86_64.rpm',
      'Thunderbolt.app.tar.gz',
      'thunderbolt-cli-linux-x64',
    ]),
  )
  expect(Object.keys(parsed.downloads)).toHaveLength(7)
  expect(parsed.downloads['mac-arm']).toBe(
    'https://github.com/thunderbird/thunderbolt/releases/download/v0.1.162/Thunderbolt_0.1.162_aarch64.dmg',
  )
  expect(parsed.downloads['windows-arm']).toEndWith('/Thunderbolt_0.1.162_arm64-setup.exe')
})

test('incomplete releases never invent links or expose untrusted asset URLs', () => {
  const input = release(['Thunderbolt_0.1.162_x64.dmg'])
  input.assets.push({ name: 'Thunderbolt_0.1.162_aarch64.dmg', state: 'new' })
  Object.assign(input.assets[0], { browser_download_url: 'javascript:alert(1)' })
  const parsed = parseRelease(input)
  expect(parsed.downloads['mac-arm']).toBeUndefined()
  expect(parsed.downloads['mac-intel']).toStartWith('https://github.com/thunderbird/thunderbolt/releases/download/')
  expect(parseRelease(release([])).downloads).toEqual({})
})

test.each([
  null,
  {},
  { ...release([]), draft: true },
  { ...release([]), prerelease: true },
  { ...release([]), assets: null },
])('rejects malformed or non-stable release data', (input) => {
  expect(() => parseRelease(input)).toThrow('Invalid stable release')
})

test('fetches the current release and surfaces API failures for the manual fallback', async () => {
  const fetchMock = mock(async () => new Response(JSON.stringify(release([]))))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  const signal = new AbortController().signal
  expect((await loadRelease(signal)).version).toBe('v0.1.162')
  expect(fetchMock.mock.calls).toHaveLength(1)
  fetchMock.mockResolvedValueOnce(new Response('', { status: 403 }))
  await expect(loadRelease(signal)).rejects.toThrow('403')
})

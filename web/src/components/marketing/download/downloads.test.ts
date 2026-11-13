/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, mock, test } from 'bun:test'
import { detectPlatform, loadRelease, parseRelease } from './downloads'

const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
const downloadsOf = (tag: string) => `https://github.com/thunderbird/thunderbolt/releases/download/${tag}`

/** GitHub's description of a release whose assets have all finished uploading. */
const gitHubRelease = (tag: string, names: string[]) => ({
  tag_name: tag,
  assets: names.map((name) => ({ name, state: 'uploaded' })),
})

describe('detectPlatform', () => {
  test.each([
    ['a Mac', mac, 0, 'macos'],
    ['a Mac that reports one touch point', mac, 1, 'macos'],
    ['an iPad, which presents itself as a Mac with a multi-touch screen', mac, 2, 'ios'],
    ['an iPad asking for the mobile site', 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', 5, 'ios'],
    ['an iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5, 'ios'],
    ['an iPod touch', 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X)', 5, 'ios'],
    ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0, 'windows'],
    ['Linux', 'Mozilla/5.0 (X11; Linux x86_64)', 0, 'linux'],
    ['Android, which also names Linux', 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', 5, 'android'],
    ['ChromeOS, which has no installer', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)', 0, 'unknown'],
    ['a browser that says nothing', '', 0, 'unknown'],
  ] as const)('recognises %s', (_, userAgent, touchPoints, platform) => {
    expect(detectPlatform(userAgent, touchPoints)).toBe(platform)
  })
})

describe('parseRelease', () => {
  test('offers each installer a release ships, and nothing else in it', () => {
    const release = parseRelease(
      gitHubRelease('v0.1.165', [
        'SHA256SUMS',
        'Thunderbolt-0.1.165-1.x86_64.rpm',
        'Thunderbolt.app.tar.gz',
        'Thunderbolt.app.tar.gz.sig',
        'Thunderbolt_0.1.165_aarch64.dmg',
        'Thunderbolt_0.1.165_amd64.AppImage',
        'Thunderbolt_0.1.165_amd64.deb',
        'Thunderbolt_0.1.165_arm64-setup.exe',
        'Thunderbolt_0.1.165_arm64_en-US.msi',
        'Thunderbolt_0.1.165_x64-setup.exe',
        'Thunderbolt_0.1.165_x64.dmg',
        'Thunderbolt_0.1.165_x64_en-US.msi',
        'thunderbolt-cli-darwin-arm64',
        'thunderbolt-cli-linux-arm64',
        'thunderbolt-cli-linux-x64',
      ]),
    )

    expect(release).toEqual({
      version: 'v0.1.165',
      downloads: {
        'mac-arm': `${downloadsOf('v0.1.165')}/Thunderbolt_0.1.165_aarch64.dmg`,
        'mac-intel': `${downloadsOf('v0.1.165')}/Thunderbolt_0.1.165_x64.dmg`,
        'windows-x64': `${downloadsOf('v0.1.165')}/Thunderbolt_0.1.165_x64-setup.exe`,
        'windows-arm': `${downloadsOf('v0.1.165')}/Thunderbolt_0.1.165_arm64-setup.exe`,
        'linux-appimage': `${downloadsOf('v0.1.165')}/Thunderbolt_0.1.165_amd64.AppImage`,
        'linux-deb': `${downloadsOf('v0.1.165')}/Thunderbolt_0.1.165_amd64.deb`,
        'linux-rpm': `${downloadsOf('v0.1.165')}/Thunderbolt-0.1.165-1.x86_64.rpm`,
      },
    })
  })

  test.each([
    'evil-Thunderbolt_1.0.0_x64.dmg',
    'Thunderbolt_1.0.0_x64.dmg.sig',
    'Thunderbolt_1.0.0_amd64.AppImage.zsync',
    'prefix/Thunderbolt_1.0.0_amd64.deb',
    'Thunderbolt_1.0.0_x64-setup.exe?download=1',
  ])('does not take %s for an installer', (name) => {
    expect(parseRelease(gitHubRelease('v1.0.0', [name])).downloads).toEqual({})
  })

  test('leaves out an installer that has not finished uploading', () => {
    const description = gitHubRelease('v1.0.0', ['Thunderbolt_1.0.0_x64.dmg'])
    description.assets.push({ name: 'Thunderbolt_1.0.0_aarch64.dmg', state: 'open' })

    expect(parseRelease(description).downloads).toEqual({
      'mac-intel': `${downloadsOf('v1.0.0')}/Thunderbolt_1.0.0_x64.dmg`,
    })
  })

  test('links to the official repository, whatever address or tag the description carries', () => {
    const description = {
      tag_name: 'v1/../../../../evil/repository',
      assets: [
        { name: 'Thunderbolt_1.0.0_x64.dmg', state: 'uploaded', browser_download_url: 'https://evil.test/x.dmg' },
      ],
    }

    expect(parseRelease(description).downloads).toEqual({
      'mac-intel': `${downloadsOf('v1%2F..%2F..%2F..%2F..%2Fevil%2Frepository')}/Thunderbolt_1.0.0_x64.dmg`,
    })
  })

  test.each([
    ['null', null],
    ['a string', 'v1.0.0'],
    ['an empty object', {}],
    ['a description with no tag', { assets: [] }],
    ['a description whose tag is not a string', { tag_name: 1, assets: [] }],
    ['a description with no assets', { tag_name: 'v1.0.0' }],
    ['a description whose assets are not a list', { tag_name: 'v1.0.0', assets: {} }],
  ])('rejects %s', (_, value) => {
    expect(() => parseRelease(value)).toThrow('Invalid release')
  })
})

describe('loadRelease', () => {
  const { signal } = new AbortController()

  test("reads the release from the website's own copy of it", async () => {
    const request = mock(async (_url: string, _init: RequestInit) =>
      Response.json(gitHubRelease('v2.0.0', ['Thunderbolt_2.0.0_x64.dmg'])),
    )

    const release = await loadRelease(signal, request)

    expect(release).toEqual({
      version: 'v2.0.0',
      downloads: { 'mac-intel': `${downloadsOf('v2.0.0')}/Thunderbolt_2.0.0_x64.dmg` },
    })
    expect(request.mock.calls).toEqual([['/downloads/release.json', { signal }]])
  })

  test('fails, naming the status, when the website answers with an error', async () => {
    const request = mock(async () => new Response('', { status: 503 }))

    await expect(loadRelease(signal, request)).rejects.toThrow('Release lookup failed: 503')
  })
})

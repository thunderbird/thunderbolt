/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadReleaseSnapshot, shareLookup } from './release-snapshot'

const directory = mkdtempSync(join(tmpdir(), 'release-snapshot-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** A path where no build step saved a release. */
const nothingSaved = join(directory, 'nothing-saved.json')
const save = (name: string, contents: unknown) => {
  const path = join(directory, name)
  writeFileSync(path, JSON.stringify(contents))
  return path
}

const gitHubRelease = {
  tag_name: 'v2.0.0',
  draft: false,
  prerelease: false,
  assets: [{ name: 'Thunderbolt_2.0.0_aarch64.dmg', state: 'uploaded' }],
}
const release = {
  version: 'v2.0.0',
  downloads: {
    'mac-arm': 'https://github.com/thunderbird/thunderbolt/releases/download/v2.0.0/Thunderbolt_2.0.0_aarch64.dmg',
  },
}

/** A stand-in for `fetch` that records what it was asked. */
const answering = (answer: () => Response) => mock(async (_url: string, _init: RequestInit) => answer())

describe('loadReleaseSnapshot', () => {
  test('asks GitHub for the latest release when none was saved', async () => {
    const request = answering(() => Response.json(gitHubRelease))

    const snapshot = await loadReleaseSnapshot({ savedPath: nothingSaved, request })

    expect(snapshot).toEqual({ raw: gitHubRelease, release })
    expect(request).toHaveBeenCalledTimes(1)
    const [url, init] = request.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/thunderbird/thunderbolt/releases/latest')
    expect(init.headers).toEqual({ Accept: 'application/vnd.github+json', 'User-Agent': 'Thunderbolt-Website' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  test('uses the release a build step saved, without asking GitHub', async () => {
    const request = answering(() => Response.json({ ...gitHubRelease, tag_name: 'v9.9.9' }))

    const snapshot = await loadReleaseSnapshot({ savedPath: save('saved.json', gitHubRelease), request })

    expect(snapshot).toEqual({ raw: gitHubRelease, release })
    expect(request).not.toHaveBeenCalled()
  })

  test("fails with GitHub's answer when it refuses the lookup", async () => {
    const request = answering(() => new Response('API rate limit exceeded', { status: 403 }))

    await expect(loadReleaseSnapshot({ savedPath: nothingSaved, request })).rejects.toThrow(
      'GitHub answered the release lookup with 403: API rate limit exceeded',
    )
  })

  test('fails when GitHub cannot be reached', async () => {
    const request = mock(async () => {
      throw new TypeError('Network unavailable')
    })

    await expect(loadReleaseSnapshot({ savedPath: nothingSaved, request })).rejects.toThrow('Network unavailable')
  })

  test.each([
    ['GitHub answers with', { savedPath: nothingSaved, request: answering(() => Response.json({})) }],
    ['a build step saved', { savedPath: save('not-a-release.json', {}) }],
  ])('fails when %s something other than a stable release', async (_, sources) => {
    await expect(loadReleaseSnapshot(sources)).rejects.toThrow('Invalid stable release')
  })
})

describe('shareLookup', () => {
  test('gives concurrent callers the result of one lookup', async () => {
    const lookUp = mock(async () => ({ version: 'v2.0.0' }))
    const shared = shareLookup(lookUp)

    const [first, second] = await Promise.all([shared(), shared()])

    expect(first).toEqual({ version: 'v2.0.0' })
    expect(second).toBe(first)
    expect(lookUp).toHaveBeenCalledTimes(1)
  })

  test('looks up again after a failure, and keeps the first result it gets', async () => {
    const lookUp = mock(async () => 'v2.0.0').mockRejectedValueOnce(new Error('offline'))
    const shared = shareLookup(lookUp)

    await expect(shared()).rejects.toThrow('offline')
    expect(await shared()).toBe('v2.0.0')
    expect(await shared()).toBe('v2.0.0')
    expect(lookUp).toHaveBeenCalledTimes(2)
  })
})

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parseRelease, type DownloadRelease, type Fetch } from '../components/marketing/download/downloads'

const latestReleaseUrl = 'https://api.github.com/repos/thunderbird/thunderbolt/releases/latest'

export type ReleaseSnapshot = {
  /** GitHub's description of the release, which `/downloads/release.json` serves as it is. */
  raw: unknown
  release: DownloadRelease
}

const lookUpLatestRelease = async (request: Fetch): Promise<unknown> => {
  const response = await request(latestReleaseUrl, {
    signal: AbortSignal.timeout(5_000),
    // GitHub refuses requests that name no user agent.
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Thunderbolt-Website' },
  })
  if (!response.ok) {
    throw new Error(`GitHub answered the release lookup with ${response.status}: ${await response.text()}`)
  }
  return response.json()
}

/**
 * Read the latest stable release for a build to embed. A build without a valid release fails:
 * the site is never published with stale or missing downloads.
 *
 * CI saves GitHub's answer to `savedPath` (relative to `web/`) before it builds. It can use a
 * token there, and GitHub rate limits anonymous lookups by address, which hosted runners
 * share. The same file lets a build run offline. Any other build asks GitHub itself.
 */
export const loadReleaseSnapshot = async ({
  savedPath = 'release-snapshot.json',
  request = fetch,
}: { savedPath?: string; request?: Fetch } = {}): Promise<ReleaseSnapshot> => {
  const raw: unknown = existsSync(savedPath)
    ? JSON.parse(await readFile(savedPath, 'utf8'))
    : await lookUpLatestRelease(request)
  return { raw, release: parseRelease(raw) }
}

/**
 * Make every caller wait on one lookup. A lookup that fails is not kept, so the next caller
 * tries again: `astro dev` recovers from a failure without a restart.
 */
export const shareLookup = <Result>(lookUp: () => Promise<Result>) => {
  let shared: Promise<Result> | undefined
  return () =>
    (shared ??= lookUp().catch((error: unknown) => {
      shared = undefined
      throw error
    }))
}

/** The release that both download pages and `/downloads/release.json` are built from. */
export const getReleaseSnapshot = shareLookup(loadReleaseSnapshot)

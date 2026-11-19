/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import fallback from '../data/download-release.json'
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
 * Use a snapshot supplied by CI, or refresh once from GitHub. If GitHub is unavailable,
 * keep the known-good bundled release so unrelated website builds can still ship.
 * A supplied snapshot is validated strictly: a broken build input must not be hidden.
 */
export const loadReleaseSnapshot = async ({
  savedPath = 'release-snapshot.json',
  request = fetch,
}: { savedPath?: string; request?: Fetch } = {}): Promise<ReleaseSnapshot> => {
  if (existsSync(savedPath)) {
    const raw: unknown = JSON.parse(await readFile(savedPath, 'utf8'))
    return { raw, release: parseRelease(raw) }
  }
  try {
    const raw = await lookUpLatestRelease(request)
    return { raw, release: parseRelease(raw) }
  } catch (error) {
    console.warn('Release lookup failed; building with the last-known-good snapshot', error)
    return { raw: fallback, release: parseRelease(fallback) }
  }
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

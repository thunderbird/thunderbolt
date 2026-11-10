/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import fallback from '../data/download-release.json'
import { parseRelease } from '../components/marketing/download/downloads'

const upstream = 'https://api.github.com/repos/thunderbird/thunderbolt/releases/latest'

/** Resolve a build-time snapshot; offline builds retain the checked-in stable release. */
export const fetchReleaseSnapshot = async (): Promise<unknown> => {
  try {
    const response = await fetch(upstream, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Thunderbolt-Website' },
    })
    if (!response.ok) throw new Error(`Release lookup failed: ${response.status}`)
    const snapshot: unknown = await response.json()
    parseRelease(snapshot)
    return snapshot
  } catch {
    return fallback
  }
}

let snapshot: Promise<unknown> | undefined

/** Share one lookup across the homepage, download page, and static fallback per build. */
export const getReleaseSnapshot = () => (snapshot ??= fetchReleaseSnapshot())

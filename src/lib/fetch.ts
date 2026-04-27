/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getSettings } from '@/dal'
import { getDb } from '@/db/database'
import { isTauri } from '@/lib/platform'

/**
 * Custom fetch function that handles CORS issues by routing through Tauri when available
 * @param input - The resource to fetch
 * @param init - Optional request configuration
 * @returns Promise that resolves to the Response
 */
export const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (!isTauri()) {
    return globalThis.fetch(input, init)
  }

  const db = getDb()
  const { isNativeFetchEnabled } = await getSettings(db, { is_native_fetch_enabled: false })

  if (isNativeFetchEnabled) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
    return tauriFetch(input, init)
  }

  return globalThis.fetch(input, init)
}

// Bun's `fetch` type expects a `preconnect` method.
fetch.preconnect = () => Promise.resolve(false)

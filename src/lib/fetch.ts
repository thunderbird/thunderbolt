/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { nativeFetch } from './native-fetch'
import { isTauri } from '@/lib/platform'
import { getLocalSetting } from '@/stores/local-settings-store'

type FetchDeps = { isTauri: () => boolean; tauriFetch?: typeof tauriFetch }

/**
 * Custom fetch function that handles CORS issues by routing through Tauri when available
 * @param input - The resource to fetch
 * @param init - Optional request configuration
 * @returns Promise that resolves to the Response
 */
export const fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
  deps: FetchDeps = { isTauri },
): Promise<Response> => {
  if (!deps.isTauri()) {
    return globalThis.fetch(input, init)
  }

  if (getLocalSetting('isNativeFetchEnabled')) {
    return nativeFetch(input, init, deps.tauriFetch)
  }

  return globalThis.fetch(input, init)
}

// Bun's `fetch` type expects a `preconnect` method.
fetch.preconnect = () => Promise.resolve(false)

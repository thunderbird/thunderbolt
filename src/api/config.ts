/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createClient, type HttpClient } from '@/lib/http'
import { useConfigStore, type AppConfig } from './config-store'

/**
 * Fetches the public app config from the backend and updates the config store on success.
 * On failure the store retains its persisted localStorage value.
 * @param httpClient - Optional pre-configured client; when omitted, creates an unauthenticated client with `cloudUrl`.
 */
export const fetchConfig = async (cloudUrl: string, httpClient?: HttpClient): Promise<AppConfig | null> => {
  try {
    const client = httpClient ?? createClient({ prefixUrl: cloudUrl })
    const config = await client.get('config', { timeout: 5_000 }).json<AppConfig>()
    useConfigStore.getState().updateConfig(config)
    return config
  } catch {
    console.warn('Failed to fetch app config, using cached value')
    return null
  }
}

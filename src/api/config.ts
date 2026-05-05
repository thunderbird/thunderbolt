/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { INSECURE_DEFAULTS_DOCS_URL } from '@shared/insecure-defaults'
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
    logSecurityWarningsToConsole(config.securityWarnings)
    return config
  } catch {
    console.warn('Failed to fetch app config, using cached value')
    return null
  }
}

/**
 * Surface backend-detected default credentials in the browser DevTools
 * console as a loud, banner-styled `console.error`. Anyone who opens
 * DevTools — security auditors, QA, customer engineers, curious users —
 * will see it on the first load and the error counts toward the DevTools
 * error badge in the toolbar.
 *
 * Never logs the credential *values* — just the env-var names the backend
 * reported. Suppressed when the backend has been told to hush warnings via
 * `DANGEROUSLY_ALLOW_DEFAULT_CREDS=true` (the backend will return an empty
 * `securityWarnings` array in that case, so this is a no-op).
 */
const logSecurityWarningsToConsole = (warnings: string[] | undefined): void => {
  if (!warnings || warnings.length === 0) {
    return
  }
  const list = warnings.map((k) => `  • ${k}`).join('\n')
  console.error(
    `%c⚠  INSECURE DEFAULT CREDENTIALS DETECTED  ⚠%c\n\n` +
      `%cThis Thunderbolt deployment is using well-known default values for:%c\n` +
      `${list}\n\n` +
      `%cThese values are public in the source tree. Anyone can read them.\n` +
      `Rotate before exposing this instance to the internet.%c\n\n` +
      `%cDocs:%c ${INSECURE_DEFAULTS_DOCS_URL}\n\n` +
      `%cSuppress this warning (do not do this in production):%c DANGEROUSLY_ALLOW_DEFAULT_CREDS=true`,
    'background:#b00020;color:#fff;font-size:18px;font-weight:bold;padding:12px 16px;letter-spacing:1px;',
    '',
    'color:#b00020;font-size:14px;font-weight:bold;',
    '',
    'color:#b00020;font-size:13px;',
    '',
    'color:#444;font-weight:bold;',
    'color:#444;',
    'color:#888;font-size:12px;',
    'color:#888;font-size:12px;font-family:monospace;',
  )
}

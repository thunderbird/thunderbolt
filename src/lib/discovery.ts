/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createClient, HttpError } from '@/lib/http'

/**
 * Public server ORIGIN (no `/v1`) used for email→server discovery, the free
 * tier, and the integrations OAuth proxy in standalone mode. Callers append the
 * `/v1/...` path themselves (`discoverServer`, `buildFreeModelRequest`,
 * `createFreeProxyFetch`), so we normalize away any trailing `/v1` or slash —
 * `VITE_THUNDERBOLT_CLOUD_URL` conventionally ends in `/v1`, which would
 * otherwise double up.
 */
export const getPublicServerUrl = (): string => {
  const raw =
    (import.meta.env.VITE_THUNDERBOLT_PUBLIC_URL as string | undefined) ??
    (import.meta.env.VITE_THUNDERBOLT_CLOUD_URL as string | undefined) ??
    ''
  return raw.replace(/\/+$/, '').replace(/\/v1$/, '')
}

export type DiscoveryResult = { ok: true; serverUrl: string } | { ok: false; message: string }

/**
 * Email → server discovery (spec-standalone-onboarding §10). POSTs to the public
 * server's `/v1/discovery` endpoint. The server returns a uniform response
 * regardless of whether the email matches a known server (privacy — mirrors the
 * waitlist flow), so a non-match surfaces as a generic "no server found".
 *
 * NOTE: depends on the backend `POST /v1/discovery` route (built separately). If
 * the backend mounts discovery at a different path, align the path here.
 */
export const discoverServer = async (email: string): Promise<DiscoveryResult> => {
  const base = getPublicServerUrl()
  if (!base) {
    return { ok: false, message: 'No public server is configured for discovery.' }
  }
  const client = createClient({ prefixUrl: `${base.replace(/\/+$/, '')}/v1` })
  try {
    const res = await client.post('discovery', { json: { email }, timeout: 8_000 }).json<{ serverUrl?: string }>()
    if (!res?.serverUrl) {
      return { ok: false, message: "We couldn't find a server for that email." }
    }
    return { ok: true, serverUrl: res.serverUrl }
  } catch (err) {
    return err instanceof HttpError
      ? { ok: false, message: "We couldn't find a server for that email." }
      : { ok: false, message: "Couldn't reach the discovery service." }
  }
}

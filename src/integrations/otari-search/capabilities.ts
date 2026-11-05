/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { http } from '@/lib/http'
import { fetch as nativeFetch } from '@/lib/fetch'

export type OtariSearchStatus = 'available' | 'not_configured' | 'workspace_disabled' | 'unknown'

export type OtariWebCapabilities = { search: OtariSearchStatus; fetch: OtariSearchStatus }

const toolsResponse = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      direct_available: z.boolean().nullish(),
      reason: z.string().nullish(),
    }),
  ),
})

/** Discovers direct search and fetching; in-model tool availability does not imply these endpoints work. */
export const loadOtariWebCapabilities = async (
  baseUrl: string,
  key: string,
  signal: AbortSignal,
): Promise<OtariWebCapabilities> => {
  signal.throwIfAborted()
  try {
    const response = toolsResponse.parse(
      await http
        .get(`${baseUrl}/tools`, {
          headers: { Authorization: `Bearer ${key}` },
          credentials: 'omit',
          redirect: 'error',
          fetch: nativeFetch,
          signal,
          timeout: 10_000,
        })
        .json<unknown>(),
    )
    const status = (id: string): OtariSearchStatus => {
      const tool = response.data.find((tool) => tool.id === id)
      if (tool?.direct_available === true) {
        return 'available'
      }
      if (tool?.direct_available !== false) {
        return 'unknown'
      }
      return tool?.reason === 'not_configured' || tool?.reason === 'workspace_disabled' ? tool.reason : 'unknown'
    }
    return { search: status('otari_web_search'), fetch: status('otari_web_fetch') }
  } catch {
    signal.throwIfAborted()
    return { search: 'unknown', fetch: 'unknown' }
  }
}

/** Checks whether onboarding can configure Otari as its search provider. */
export const loadOtariSearchStatus = async (baseUrl: string, key: string, signal: AbortSignal) =>
  (await loadOtariWebCapabilities(baseUrl, key, signal)).search

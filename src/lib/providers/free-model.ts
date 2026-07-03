/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { v7 as uuidv7 } from 'uuid'
import { targetUrlHeader } from '../../../shared/proxy-protocol'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { createModel } from '@/dal/models'
import { getPublicServerUrl } from '@/lib/discovery'
import { findModelRowForCatalogEntry } from '@/lib/providers/model-catalog'

/**
 * Sentinel `providerId` marking a curated model row as free-tier. There is no
 * `providers` row with this id — `src/ai/fetch.ts` detects the sentinel and
 * routes the model through `/v1/proxy/free` (no user key), and
 * `hydrateProviderModel` leaves it untouched (no provider/secret lookup match).
 */
export const freeTierProviderId = 'free-tier'

/**
 * Free-tier model access (spec-standalone §8). Routes an OpenRouter chat
 * completion through the PUBLIC server's `/v1/proxy/free` endpoint, which holds
 * the hosted key server-side (`FREE_TIER_OPENROUTER_KEY`), allowlists
 * `openrouter.ai`, and applies a per-device daily rate limit. No credential is
 * sent from the client — the endpoint is unauthenticated and injects the key.
 * Fragile/rate-limited by design; callers surface failures gracefully.
 */

/** A low-cost, broadly-available default for the free tier. */
export const freeModelId = 'openrouter/auto'

/**
 * Create (idempotently) the curated free-tier model row and return its id, so
 * onboarding can set it as `selected_model` and the user can chat immediately
 * with zero config. Routed at chat time via {@link freeTierProviderId}.
 */
export const enableFreeModel = async (db: AnyDrizzleDatabase, workspaceId: string, userId: string): Promise<string> => {
  const existing = await findModelRowForCatalogEntry(db, workspaceId, freeTierProviderId, freeModelId)
  if (existing) {
    return existing.id
  }
  const id = uuidv7()
  await createModel(db, workspaceId, {
    id,
    provider: 'openrouter',
    providerId: freeTierProviderId,
    name: 'Free model',
    model: freeModelId,
    enabled: 1,
    userId,
  })
  return id
}

const openrouterChatUrl = 'https://openrouter.ai/api/v1/chat/completions'

export type FreeModelRequestParams = {
  model?: string
  prompt: string
  maxTokens?: number
}

/** Build the `/v1/proxy/free` request that reaches OpenRouter via the public server. */
export const buildFreeModelRequest = (
  publicServerUrl: string,
  params: FreeModelRequestParams,
): { url: string; init: RequestInit } => {
  const base = publicServerUrl.replace(/\/+$/, '')
  return {
    url: `${base}/v1/proxy/free`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [targetUrlHeader]: openrouterChatUrl,
      },
      body: JSON.stringify({
        model: params.model ?? freeModelId,
        max_tokens: params.maxTokens ?? 1,
        messages: [{ role: 'user', content: params.prompt }],
      }),
    },
  }
}

export type FreeModelResult = { ok: true } | { ok: false; error: string }

/**
 * Verify the free tier is reachable (the onboarding "Try a free model" hard
 * gate). Returns a friendly error when no public server is configured, the
 * device is rate-limited, or the endpoint is unavailable.
 */
export const tryFreeModel = async (
  fetchFn: typeof fetch = fetch,
  publicServerUrl: string = getPublicServerUrl(),
): Promise<FreeModelResult> => {
  if (!publicServerUrl) {
    return { ok: false, error: 'No public server is configured for the free tier.' }
  }
  const { url, init } = buildFreeModelRequest(publicServerUrl, { prompt: 'Hi', maxTokens: 1 })
  try {
    const res = await fetchFn(url, init)
    if (res.status === 429) {
      return { ok: false, error: 'Free-tier daily limit reached. Connect your own provider to continue.' }
    }
    if (!res.ok) {
      return { ok: false, error: `Free model unavailable (${res.status}).` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

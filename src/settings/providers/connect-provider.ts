/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { v7 as uuidv7 } from 'uuid'
import { createProvider, setProviderCredentials } from '@/dal'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getProviderDefinition, type ProviderType } from '@shared/providers'
import { validateModelsCapability, validateSearchCapability, type ValidationResult } from '@/lib/providers/validate'
import type { ProviderRequestContext } from '@/lib/providers/requests'

/**
 * Validate a freshly-supplied credential for a provider by exercising its
 * primary capability: `models`-capable providers list `/models` + a 1-token
 * completion; otherwise a single search query. Returns the underlying
 * {@link ValidationResult} so the UI can surface the upstream error inline.
 */
export const validateConnection = async (
  type: ProviderType,
  ctx: ProviderRequestContext,
  fetchFn: typeof fetch,
): Promise<ValidationResult> => {
  const def = getProviderDefinition(type)
  return def.capabilities.includes('models')
    ? validateModelsCapability(type, ctx, fetchFn)
    : validateSearchCapability(type, ctx, fetchFn)
}

/** Dependencies for {@link connectProvider} — the active DB, workspace, user, and proxy-aware fetch. */
export type ConnectProviderDeps = {
  db: AnyDrizzleDatabase
  workspaceId: string
  userId: string
  fetchFn: typeof fetch
}

/** User-supplied connection details. `apiKey`/`baseUrl` are per connection type. */
export type ConnectProviderInput = {
  type: ProviderType
  apiKey?: string
  baseUrl?: string
  label?: string | null
  scope?: 'workspace' | 'user'
}

export type ConnectProviderResult = { providerId: string; validation: ValidationResult }

/**
 * Persist a new provider connection (synced metadata row + local-only secret),
 * then run a validation test against the provider. Follows spec.md §4.1 order:
 * connect first, then surface the live test result to the caller. The row and
 * secret are kept regardless of the test outcome so the user can retry or
 * disconnect from the detail page.
 */
export const connectProvider = async (
  deps: ConnectProviderDeps,
  input: ConnectProviderInput,
): Promise<ConnectProviderResult> => {
  const def = getProviderDefinition(input.type)
  const providerId = uuidv7()
  const trimmedBaseUrl = input.baseUrl?.trim() || undefined

  await createProvider(deps.db, deps.workspaceId, {
    id: providerId,
    type: input.type,
    label: input.label ?? null,
    baseUrl: def.connectionType === 'url' ? (trimmedBaseUrl ?? def.defaultBaseUrl ?? null) : null,
    enabledCapabilities: def.capabilities,
    userId: deps.userId,
    scope: input.scope,
  })

  if (input.apiKey) {
    await setProviderCredentials(deps.db, providerId, { apiKey: input.apiKey })
  }

  const validation = await validateConnection(
    input.type,
    { apiKey: input.apiKey, baseUrl: trimmedBaseUrl },
    deps.fetchFn,
  )
  return { providerId, validation }
}

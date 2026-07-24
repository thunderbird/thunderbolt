/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Model } from '@/types'

export type ApiKeyEdit = { kind: 'keep' } | { kind: 'replace'; value: string } | { kind: 'clear' }

/** Maps an API-key edit to DAL semantics: keep → undefined, clear → null, replace → the value. */
export const apiKeyEditValue = (edit: ApiKeyEdit): string | null | undefined => {
  if (edit.kind === 'keep') {
    return undefined
  }
  return edit.kind === 'clear' ? null : edit.value
}

/** Resolves the key used only for an explicit catalog refresh or connection test. */
export const modelApiKeyForConnection = (
  storedApiKey: string | null | undefined,
  edit: ApiKeyEdit,
): string | undefined => {
  if (edit.kind === 'replace') {
    return edit.value
  }
  return edit.kind === 'keep' ? (storedApiKey ?? undefined) : undefined
}

export type ModelConnectionDraft = Pick<Model, 'model'> & {
  url?: string | null
  apiKeyEdit: ApiKeyEdit
}

/** Whether saving a draft changes fields used to connect to the provider. */
export const hasModelConnectionChanges = (model: Pick<Model, 'model' | 'url'>, draft: ModelConnectionDraft): boolean =>
  model.model !== draft.model || (model.url ?? '') !== (draft.url ?? '') || draft.apiKeyEdit.kind !== 'keep'

/** Whether adding a model must pass Test Connection first. Thunderbolt models
 *  are server-authenticated and preconfigured, so there is nothing to verify. */
export const providerRequiresConnectionTest = (provider: Model['provider']): boolean => provider !== 'thunderbolt'

/** Whether chatting through the provider needs a user-supplied API key.
 *  Thunderbolt is server-authenticated; custom (OpenAI-compatible) endpoints
 *  treat the key as optional. */
export const providerRequiresApiKey = (provider: Model['provider']): boolean =>
  provider !== 'thunderbolt' && provider !== 'custom'

/**
 * Models that require an API key but don't have one yet need configuration.
 * System Tinfoil rows are server-authenticated (the key is injected by the
 * backend proxy), so they never flag as missing.
 */
export const needsApiKey = (model: Pick<Model, 'provider' | 'isSystem' | 'apiKey'>): boolean => {
  if (!providerRequiresApiKey(model.provider)) {
    return false
  }
  if (model.provider === 'tinfoil' && model.isSystem === 1) {
    return false
  }
  return !model.apiKey
}

/**
 * Whether fetching the provider's model catalog needs a user-supplied API key.
 * Narrower than `providerRequiresApiKey`: Tinfoil and Anthropic need a key to
 * chat, but their catalogs load without one.
 */
export const catalogRequiresApiKey = (provider: Model['provider']): boolean =>
  provider === 'openai' || provider === 'openrouter'

/** Providers whose catalog loads without credentials, so forms fetch it eagerly. */
export const providerAutoFetchesCatalog = (provider: Model['provider']): boolean =>
  provider === 'thunderbolt' || provider === 'anthropic' || provider === 'tinfoil'

/** Submission gate for the add-model form. */
export const shouldDisableAddModel = ({
  isPending,
  isFormValid,
  provider,
  connectionStatus,
}: {
  isPending: boolean
  isFormValid: boolean
  provider: Model['provider']
  connectionStatus: 'idle' | 'success' | 'error'
}): boolean => isPending || !isFormValid || (providerRequiresConnectionTest(provider) && connectionStatus !== 'success')

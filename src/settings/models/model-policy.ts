/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Model } from '@/types'

export type ApiKeyEdit = { kind: 'keep' } | { kind: 'replace'; value: string } | { kind: 'clear' }

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

export const providerRequiresConnectionTest = (provider: Model['provider']): boolean => provider !== 'thunderbolt'

export const providerRequiresApiKey = (provider: Model['provider']): boolean =>
  provider !== 'thunderbolt' && provider !== 'custom'

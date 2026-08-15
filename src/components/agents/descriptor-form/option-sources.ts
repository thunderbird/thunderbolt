/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Resolves a field's `select`/`option-cards` options at render time. `inline`
 * sources ship their options in the descriptor; `fetched` sources name a
 * `sourceId` a hook resolves from client state (e.g. `account-models` from the
 * synced `models` table). The registry keeps `DescriptorForm` presentational —
 * it receives the resolved map as a prop and never queries anything itself.
 */

import type { AgentField, AgentFieldOption } from '@shared/agent-descriptors'
import { useAccountModelOptions } from './use-account-model-options'

export type ResolvedOptionSource = { options: AgentFieldOption[]; isLoading: boolean }
export type OptionSources = Partial<Record<string, ResolvedOptionSource>>

/** Resolve every `fetched` source into a map keyed by `sourceId`. */
export const useDescriptorOptionSources = (): OptionSources => {
  const accountModels = useAccountModelOptions()
  return { 'account-models': accountModels }
}

/** The options to render for a field: inline options verbatim, or the resolved fetched source (or none). */
export const fieldOptions = (field: AgentField, sources: OptionSources): AgentFieldOption[] => {
  if (!field.source) {
    return []
  }
  if (field.source.kind === 'inline') {
    return field.source.options
  }
  return sources[field.source.sourceId]?.options ?? []
}

/** Whether a field's fetched source is still loading (inline sources are never loading). */
export const fieldOptionsLoading = (field: AgentField, sources: OptionSources): boolean => {
  if (field.source?.kind !== 'fetched') {
    return false
  }
  return sources[field.source.sourceId]?.isLoading ?? false
}

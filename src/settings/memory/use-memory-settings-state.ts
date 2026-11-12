/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer, useTransition } from 'react'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQueryClient } from '@tanstack/react-query'
import { useLingui } from '@lingui/react/macro'
import { useDatabase } from '@/contexts'
import { useSettings } from '@/hooks/use-settings'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { getAvailableModels, getModel, getModelProfile } from '@/dal'
import { saveMemoryDocument, MemoryConflictError } from '@/dal/memories'
import { compactMemories, MemoryNotShorterError } from '@/memory/compact'
import { getMemoryUsage, MemoryValidationError } from '@/memory/limits'
import { useProxyFetchGetter } from '@/lib/proxy-fetch-context'
import { getIdentitySignal } from '@/lib/identity-lifetime'
import { defaultModelId } from '@shared/defaults/models'

type State = {
  edit: { before: string; draft: string } | null
  preview: { before: string; after: string } | null
  error: string | null
  compacting: boolean
}
const initialState: State = { edit: null, preview: null, error: null, compacting: false }

/** Keep explicit drafts and reviewed rewrites separate from the synced memory document. */
export const useMemorySettingsState = ({ initialEditContent }: { initialEditContent?: string } = {}) => {
  const { t } = useLingui()
  const db = useDatabase()
  const queryClient = useQueryClient()
  const getProxyFetch = useProxyFetchGetter()
  const { copy, isCopied } = useCopyToClipboard()
  const [state, patch] = useReducer((state: State, patch: Partial<State>) => ({ ...state, ...patch }), {
    ...initialState,
    edit: initialEditContent === undefined ? null : { before: initialEditContent, draft: initialEditContent },
  })
  const [pending, startTransition] = useTransition()
  const { memoryContent, memoryEnabled, memoryProvider, sessionHistoryEnabled, selectedModel } = useSettings({
    memory_content: '',
    memory_provider: 'builtin',
    memory_enabled: false,
    session_history_enabled: false,
    selected_model: '',
  })
  const { data: models = [] } = useQuery({ queryKey: ['models'], query: toCompilableQuery(getAvailableModels(db)) })
  const model = selectedModel.isLoading
    ? undefined
    : (models.find(({ id }) => id === selectedModel.value) ??
      models.find(({ id }) => id === defaultModelId) ??
      models[0])
  const text = state.edit?.draft ?? memoryContent.value
  const usage = getMemoryUsage(text)
  const run = (action: (signal: AbortSignal) => Promise<void>, compacting = false) => {
    if (pending) {
      return
    }
    const identity = getIdentitySignal()
    patch({ error: null, compacting })
    startTransition(async () => {
      try {
        identity.throwIfAborted()
        await action(identity)
        identity.throwIfAborted()
        await queryClient.invalidateQueries({ queryKey: ['settings'] })
      } catch (error) {
        if (!identity.aborted) {
          if (error instanceof MemoryConflictError) {
            await queryClient.invalidateQueries({ queryKey: ['settings'] })
            if (identity.aborted) {
              return
            }
          }
          patch({
            error:
              error instanceof MemoryConflictError
                ? t`Memory changed while you were editing. Copy your changes, cancel, and edit the latest version.`
                : error instanceof MemoryNotShorterError
                  ? t`The model could not make memory shorter. You can edit it directly.`
                  : error instanceof MemoryValidationError
                    ? t`Memory is too long. Shorten it before saving.`
                    : t`Could not update memory. Please try again.`,
          })
        }
      } finally {
        patch({ compacting: false })
      }
    })
  }
  return {
    ...state,
    text,
    content: memoryContent.value,
    model,
    usage,
    pending,
    isLoading: memoryContent.isLoading,
    isCopied,
    memoryEnabled,
    memoryProvider,
    sessionHistoryEnabled,
    patch,
    selectProvider: (provider: string) => run((signal) => memoryProvider.setValue(provider, { signal })),
    toggleMemory: (enabled: boolean) => run((signal) => memoryEnabled.setValue(enabled, { signal })),
    toggleHistory: (enabled: boolean) => run((signal) => sessionHistoryEnabled.setValue(enabled, { signal })),
    startEditing: () => patch({ edit: { before: memoryContent.value, draft: memoryContent.value }, error: null }),
    changeDraft: (draft: string) => {
      if (state.edit) {
        patch({ edit: { ...state.edit, draft } })
      }
    },
    cancel: () => patch({ edit: null, error: null }),
    copy: async () => {
      try {
        await copy(text)
      } catch {
        patch({ error: t`Could not copy memory. Select the text and copy it manually.` })
      }
    },
    save: () =>
      run(async (signal) => {
        if (!state.edit) {
          return
        }
        await saveMemoryDocument(db, state.edit.draft, { expectedContent: state.edit.before, signal })
        signal.throwIfAborted()
        patch({ edit: null })
      }),
    compact: () =>
      run(async (signal) => {
        const before = memoryContent.value
        const selected = model && (await getModel(db, model.id))
        if (!selected) {
          throw new Error('Choose an available model')
        }
        const profile = await getModelProfile(db, selected.id)
        const after = await compactMemories({ content: before, model: selected, profile, getProxyFetch, signal })
        signal.throwIfAborted()
        patch({ preview: { before, after } })
      }, true),
    apply: () =>
      run(async (signal) => {
        if (!state.preview) {
          return
        }
        await saveMemoryDocument(db, state.preview.after, { expectedContent: state.preview.before, signal })
        signal.throwIfAborted()
        patch({ preview: null })
      }),
  }
}

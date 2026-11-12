/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useQuery as usePowerSyncQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useLingui } from '@lingui/react/macro'
import { useCurrentChatSession } from '@/chats/chat-store'
import { useSettings } from '@/hooks/use-settings'
import { useDatabase } from '@/contexts/database-context'
import { getModelReasoningEffortQuery, updateModel } from '@/dal/models'
import { getModelProviderOptionsQuery } from '@/dal/model-profiles'
import { resolveProfileReasoningEffort } from '@/ai/profile-thinking-level'
import { loadReasoningCapabilities, queueReasoningEffortWrite } from '@/ai/reasoning-effort'
import { configSelectOptions, sessionConfigKey, useSessionConfigStore } from '@/acp/session-config-store'
import { noReasoningEffort, reasoningEffortSettingKey, preferredReasoningEffort } from '@shared/reasoning-effort'

/** Resolve supported controls and commit changes between turns; ACP stays server-authoritative. */
export const useEffortSelectorState = () => {
  const { t } = useLingui()
  const db = useDatabase()
  const session = useCurrentChatSession()
  const { id, selectedModel, selectedAgent, chatInstance, compactionStatus } = session
  const builtIn = selectedAgent.type === 'built-in'
  const legacyKey = reasoningEffortSettingKey(id, selectedModel.id)
  const legacySetting = useSettings({ [legacyKey]: String }, { camelCase: false })[legacyKey]
  const modelQuery = usePowerSyncQuery({
    queryKey: ['models', selectedModel.id, 'reasoning-effort'],
    query: toCompilableQuery(getModelReasoningEffortQuery(db, selectedModel.id)),
    enabled: builtIn,
  })
  const profileQuery = usePowerSyncQuery({
    queryKey: ['model-provider-options', selectedModel.id],
    query: toCompilableQuery(getModelProviderOptionsQuery(db, selectedModel.id)),
    enabled: builtIn,
  })
  const catalog = useQuery({
    queryKey: ['reasoning-capabilities', selectedModel.provider, selectedModel.model, selectedModel.vendor],
    queryFn: () => loadReasoningCapabilities(selectedModel),
    enabled: builtIn,
    staleTime: 300_000,
    retry: false,
  })
  const remote = useSessionConfigStore((state) => state.sessions.get(sessionConfigKey(selectedAgent.id, id)))
  const option = remote?.options.find((item) => item.category === 'thought_level' && item.type === 'select')
  const capabilities = catalog.data ?? noReasoningEffort
  const effort = preferredReasoningEffort(
    modelQuery.data?.[0]?.reasoningEffort ?? legacySetting.value,
    capabilities,
    resolveProfileReasoningEffort(profileQuery.data?.[0]?.providerOptions, capabilities),
  )
  const scope = `${selectedAgent.id}:${selectedModel.id}`
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null)
  const [pending, setPending] = useState<ReadonlyMap<string, { scope: string; value: string }>>(() => new Map())
  // Built-in preferences are per model; an ACP configuration write belongs to the entire session.
  const writeScope = builtIn ? scope : sessionConfigKey(selectedAgent.id, id)
  const busy =
    pending.has(writeScope) ||
    (builtIn &&
      (modelQuery.isLoading ||
        profileQuery.isLoading ||
        legacySetting.isLoading ||
        legacySetting.query.isPlaceholderData)) ||
    chatInstance.status === 'submitted' ||
    chatInstance.status === 'streaming' ||
    compactionStatus === 'compacting'
  const labels = {
    none: t`Off`,
    minimal: t`Minimal`,
    low: t`Low`,
    medium: t`Medium`,
    high: t`High`,
    xhigh: t`Extra high`,
    max: t`Maximum`,
  }
  const choices = builtIn
    ? capabilities.efforts.map((value) => ({
        value,
        name: capabilities.kind === 'toggle' && value !== 'none' ? t`On` : labels[value],
      }))
    : option
      ? configSelectOptions(option)
      : []
  const value = builtIn ? effort : option?.currentValue
  const resolvedValue = typeof value === 'string' ? value : undefined
  const optimistic = pending.get(writeScope)
  const displayValue = optimistic?.scope === scope ? optimistic.value : resolvedValue
  const choose = async (next: string) => {
    if (busy || !choices.some((choice) => choice.value === next)) {
      return
    }
    setFailure(null)
    setPending((current) => new Map(current).set(writeScope, { scope, value: next }))
    try {
      if (builtIn) {
        await queueReasoningEffortWrite(db, selectedModel.id, async () => {
          await updateModel(db, selectedModel.id, { reasoningEffort: next })
          await modelQuery.refetch()
        })
      } else if (remote && option) {
        await remote.setOption(option.id, next)
      }
    } catch (error) {
      console.error('Could not change reasoning effort', error)
      setFailure({ scope, message: t`Could not change reasoning effort` })
    } finally {
      setPending((current) => {
        const remaining = new Map(current)
        remaining.delete(writeScope)
        return remaining
      })
    }
  }
  return {
    error: failure?.scope === scope ? failure.message : null,
    dismissError: () => setFailure(null),
    kind: builtIn ? capabilities.kind : undefined,
    choices,
    value: displayValue,
    busy,
    choose,
  }
}

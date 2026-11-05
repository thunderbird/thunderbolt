/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useOptimistic, useState, useTransition } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLingui } from '@lingui/react/macro'
import { useChatStore, useCurrentChatSession } from '@/chats/chat-store'
import { useSettings } from '@/hooks/use-settings'
import { loadReasoningCapabilities } from '@/ai/reasoning-effort'
import { configSelectOptions, sessionConfigKey, useSessionConfigStore } from '@/acp/session-config-store'
import { noReasoningEffort, reasoningEffortSettingKey, resolveReasoningEffort } from '@shared/reasoning-effort'

/** Resolve supported controls and commit changes between turns; ACP stays server-authoritative. */
export const useEffortSelectorState = () => {
  const { t } = useLingui()
  const session = useCurrentChatSession()
  const { id, selectedModel, selectedAgent, chatInstance, compactionStatus } = session
  const builtIn = selectedAgent.type === 'built-in'
  const key = reasoningEffortSettingKey(id, selectedModel.id)
  const setting = useSettings({ [key]: String }, { camelCase: false })[key]
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
  const effort = resolveReasoningEffort(setting.value, capabilities)
  const scope = `${selectedAgent.id}:${key}`
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const busy =
    pending ||
    (builtIn && (setting.isSaving || setting.isLoading)) ||
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
      ? configSelectOptions(option).filter((choice) => choice.value !== 'default')
      : []
  const value = builtIn ? effort : option?.currentValue === 'default' ? undefined : option?.currentValue
  const resolvedValue = typeof value === 'string' ? value : undefined
  const [optimistic, setOptimisticValue] = useOptimistic({ scope, value: resolvedValue })
  const displayValue = optimistic.scope === scope ? optimistic.value : resolvedValue
  const choose = (next: string) => {
    if (busy || !choices.some((choice) => choice.value === next)) {
      return
    }
    setFailure(null)
    startTransition(async () => {
      setOptimisticValue({ scope, value: next })
      try {
        if (builtIn) {
          const write = setting.setValue(next)
          useChatStore.getState().updateSession(id, { configurationChange: write })
          try {
            await write
          } finally {
            if (useChatStore.getState().sessions.get(id)?.configurationChange === write) {
              useChatStore.getState().updateSession(id, { configurationChange: undefined })
            }
          }
        } else if (remote && option) {
          await remote.setOption(option.id, next)
        }
      } catch (error) {
        console.error('Could not change reasoning effort', error)
        setFailure({ scope, message: t`Could not change reasoning effort` })
      }
    })
  }
  return { error: failure?.scope === scope ? failure.message : null, choices, value: displayValue, busy, choose }
}

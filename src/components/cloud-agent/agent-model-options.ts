/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CloudAgentModel } from '@shared/cloud-agent/contracts'
import { moveAgentModel } from '@shared/cloud-agent/agent-models'
import type { CloudModelResolution } from '@/cloud-agent/library'

export type AgentModelChoice = { source: { id: string; name: string }; resolution: CloudModelResolution }
export type AgentModelOption = { id: string; name: string; model: CloudAgentModel; enabled: boolean }

/** Keep disabled models in the saved visual order without granting them execution access. */
export const agentModelOptions = (
  models: CloudAgentModel[],
  choices: AgentModelChoice[],
  order: string[] = [],
): AgentModelOption[] => {
  const selected = models.map((model) => {
    const choice = choices.find(
      ({ source, resolution }) =>
        source.id === model.localModelId ||
        source.id === model.model?.sourceId ||
        (!model.localModelId &&
          resolution.ok &&
          resolution.model.provider === 'managed' &&
          model.model?.provider === 'managed' &&
          resolution.model.modelId === model.model.modelId),
    )
    return {
      id:
        choice?.source.id ??
        model.localModelId ??
        model.model?.sourceId ??
        `${model.model?.provider}:${model.model?.modelId}:${model.name}`,
      name: choice?.source.name ?? model.name,
      model,
      enabled: true,
    }
  })
  const available = choices
    .filter(({ source }) => !selected.some((entry) => entry.id === source.id))
    .map(({ source, resolution }) => ({
      id: source.id,
      name: source.name,
      model: { localModelId: source.id, name: source.name, model: resolution.ok ? resolution.model : null },
      enabled: false,
    }))
  const positions = new Map(order.map((id, index) => [id, index]))
  return [...selected, ...available].sort(
    (left, right) => (positions.get(left.id) ?? order.length) - (positions.get(right.id) ?? order.length),
  )
}

/** Project execution choices from visual order; the first enabled entry becomes the default. */
export const enabledAgentModels = (options: AgentModelOption[]): CloudAgentModel[] =>
  options.filter((entry) => entry.enabled).map((entry) => entry.model)

/** Reorder choices without changing which models the user has enabled. */
export const reorderAgentModelOptions = (
  options: AgentModelOption[],
  activeId: string,
  overId: string,
): AgentModelOption[] => {
  const from = options.findIndex((entry) => entry.id === activeId)
  const to = options.findIndex((entry) => entry.id === overId)
  if (from < 0 || to < 0 || from === to) {
    return options
  }
  return moveAgentModel(options, from, to)
}

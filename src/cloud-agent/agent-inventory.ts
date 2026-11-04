/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CloudAgent } from '@/types/acp'
import type { CloudAgentClient, CloudAgentView } from './client'

/** Separate cloud resources from ACP/discovered identifiers in normal chat preferences. */
export const cloudAgentSelectionId = (id: string): string => `cloud:${id}`

/** Decode only persisted cloud resource IDs; arbitrary strings never become backend paths. */
export const cloudAgentResourceId = (selectionId: string | null | undefined): string | null => {
  const match = /^cloud:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(selectionId ?? '')
  return match?.[1] ?? null
}

/** Recover a definition's identity from either persisted chat environment, including legacy cloud selections. */
export const portableAgentResourceId = (selectionId: string | null | undefined): string | null => {
  const match = /^(?:cloud|local):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    selectionId ?? '',
  )
  return match?.[1] ?? null
}

/** Environment belongs to a chat selection; the encrypted definition and its credentials are unchanged. */
export const agentInEnvironment = (agent: CloudAgent, environment: 'local' | 'cloud'): CloudAgent => ({
  ...agent,
  id: `${environment}:${agent.cloudAgentId}`,
  executionEnvironment: environment,
})

/** Project the minimum decrypted display/routing summary without retaining instructions, keys, tools, or credentials. */
export const cloudAgentToAgent = ({ record, config }: CloudAgentView, available = true): CloudAgent => ({
  id: cloudAgentSelectionId(record.id),
  cloudAgentId: record.id,
  name: config.name,
  description: config.description,
  type: 'cloud',
  transport: 'http',
  url: null,
  icon: config.icon ?? 'cloud',
  isSystem: 0,
  enabled: record.enabled && available ? 1 : 0,
  userId: record.ownerId,
  deletedAt: record.deletedAt,
  ...((config.localModelId ?? config.model?.sourceId)
    ? { localModelId: config.localModelId ?? config.model?.sourceId }
    : {}),
})

/** Owner filtering is mandatory even for cached decrypted query data; disabled agents remain identifiable for history. */
export const cloudAgentsToInventory = (views: CloudAgentView[], ownerId: string, available = true): CloudAgent[] =>
  views
    .filter(({ record }) => record.ownerId === ownerId && !record.deletedAt)
    .map((view) => cloudAgentToAgent(view, available))
    .sort((left, right) => left.name.localeCompare(right.name))

/** Non-React hydration can use the same authenticated encrypted source instead of synthesizing ordinary agent rows. */
export const loadCloudAgentInventory = async (client: CloudAgentClient, ownerId: string): Promise<CloudAgent[]> => {
  const capabilities = await client.capabilities()
  if (!capabilities.enabled) {
    return []
  }
  return cloudAgentsToInventory(await client.agents(), ownerId)
}

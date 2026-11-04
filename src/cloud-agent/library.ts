/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Model, Skill } from '@/types'
import { normalizeOpenAiBaseUrl } from '@/lib/openai-base-url'
import type { CloudModel, CloudSkill } from '@shared/cloud-agent/contracts'
import { cloudModelSchema } from '@shared/cloud-agent/validation'
import type { CloudConnectionView } from './client'
import { isCloudPublicEndpoint } from './connection-library'

export type CloudLibraryIssue =
  | 'model_deleted'
  | 'model_tools_unsupported'
  | 'model_provider_unsupported'
  | 'managed_model_unavailable'
  | 'model_endpoint_unavailable'
  | 'model_connection_required'
  | 'model_connection_unavailable'
  | 'model_connection_changed'
  | 'model_limits_required'
  | 'skill_missing'
  | 'skill_instruction_missing'

export class CloudLibraryError extends Error {
  constructor(
    readonly code: CloudLibraryIssue,
    readonly sourceId: string,
  ) {
    super(code)
  }
}

const canonicalEndpoint = (value: string): string | null => {
  try {
    const url = new URL(value)
    if (!isCloudPublicEndpoint(value) || url.search) {
      return null
    }
    return url.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/** Cloud credentials bind to the existing model's endpoint, never to its device-local API key. */
export const modelCloudEndpoint = (model: Pick<Model, 'provider' | 'url'>): string | null => {
  if (model.provider === 'openai') {
    return 'https://api.openai.com/v1'
  }
  if (model.provider === 'openrouter') {
    return 'https://openrouter.ai/api/v1'
  }
  if (model.provider === 'anthropic') {
    return 'https://api.anthropic.com/v1'
  }
  if (model.provider === 'custom' && model.url) {
    return canonicalEndpoint(normalizeOpenAiBaseUrl(model.url))
  }
  return null
}

export type CloudModelResolution = { ok: true; model: CloudModel } | { ok: false; code: CloudLibraryIssue }

/** Resolve a portable saved model snapshot from a library row and its separately authorized cloud connection. */
export const resolveCloudModel = (
  model: Model,
  { managedModel, binding }: { managedModel: CloudModel | null; binding?: CloudConnectionView },
): CloudModelResolution => {
  if (model.deletedAt) {
    return { ok: false, code: 'model_deleted' }
  }
  if (!model.toolUsage) {
    return { ok: false, code: 'model_tools_unsupported' }
  }
  if (model.provider === 'tinfoil' && model.isSystem === 1) {
    return managedModel?.provider === 'managed' && managedModel.modelId === model.model
      ? { ok: true, model: { ...managedModel, sourceId: model.id } }
      : { ok: false, code: 'managed_model_unavailable' }
  }
  if (!['openai', 'openrouter', 'custom', 'anthropic'].includes(model.provider)) {
    return { ok: false, code: 'model_provider_unsupported' }
  }
  const endpoint = modelCloudEndpoint(model)
  if (!endpoint) {
    return { ok: false, code: 'model_endpoint_unavailable' }
  }
  if (!binding) {
    return { ok: false, code: 'model_connection_required' }
  }
  if (
    !binding.record.enabled ||
    binding.record.deletedAt ||
    ['needs-authorization', 'unreachable'].includes(binding.record.status)
  ) {
    return { ok: false, code: 'model_connection_unavailable' }
  }
  if (
    binding.config.kind !== 'model' ||
    binding.config.libraryRef?.kind !== 'model' ||
    binding.config.libraryRef.id !== model.id ||
    canonicalEndpoint(binding.config.url) !== endpoint
  ) {
    return { ok: false, code: 'model_connection_changed' }
  }
  const limits = binding.config.modelLimits
  if (!limits) {
    return { ok: false, code: 'model_limits_required' }
  }
  const snapshot = cloudModelSchema.safeParse({
    sourceId: model.id,
    provider: model.provider === 'anthropic' ? 'anthropic' : 'openai-compatible',
    modelId: model.model,
    baseUrl: endpoint,
    connectionId: binding.record.id,
    contextWindow: limits.contextWindow,
    maxOutputTokens: limits.maxOutputTokens,
    inputCostPerMillion: limits.inputCostPerMillion,
    outputCostPerMillion: limits.outputCostPerMillion,
  })
  return snapshot.success ? { ok: true, model: snapshot.data } : { ok: false, code: 'model_limits_required' }
}

/** Older snapshots have no source ID; preserve them explicitly instead of guessing identity from a mutable name. */
export const cloudSkillSelection = (skills: readonly CloudSkill[]): { ids: string[]; legacy: CloudSkill[] } => ({
  ids: [...new Set(skills.flatMap((skill) => (skill.sourceId ? [skill.sourceId] : [])))],
  legacy: skills.filter((skill) => !skill.sourceId).map((skill) => ({ ...skill })),
})

/** Agent selection is independent of the library's chat enable switch; save the latest complete instructions by ID. */
export const resolveCloudSkills = (
  ids: readonly string[],
  library: readonly Skill[],
  legacy: readonly CloudSkill[] = [],
): CloudSkill[] => {
  const byId = new Map(library.filter((skill) => !skill.deletedAt).map((skill) => [skill.id, skill]))
  const selected = [...new Set(ids)].map((id) => {
    const skill = byId.get(id)
    if (!skill) {
      throw new CloudLibraryError('skill_missing', id)
    }
    if (!skill.instruction.trim()) {
      throw new CloudLibraryError('skill_instruction_missing', id)
    }
    return { sourceId: skill.id, name: skill.name, description: skill.description, instruction: skill.instruction }
  })
  return [...selected, ...legacy.filter((skill) => !skill.sourceId).map((skill) => ({ ...skill }))]
}

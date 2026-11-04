/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { Model, Skill } from '@/types'
import type { CloudModel } from '@shared/cloud-agent/contracts'
import { cloudAgentConfigSchema, cloudModelSchema } from '@shared/cloud-agent/validation'
import { defaultModelDeepSeekV41Flash } from '@shared/defaults/models'
import type { CloudConnectionView } from './client'
import { cloudSkillSelection, modelCloudEndpoint, resolveCloudModel, resolveCloudSkills } from './library'

const model = (changes: Partial<Model> = {}): Model => ({
  ...defaultModelDeepSeekV41Flash,
  apiKey: 'DEVICE-ONLY-SECRET',
  ...changes,
})
const managed: CloudModel = {
  provider: 'managed',
  modelId: defaultModelDeepSeekV41Flash.model,
  contextWindow: 131072,
  maxOutputTokens: 8192,
}
const custom = model({
  id: 'library-model',
  provider: 'custom',
  model: 'chosen-model',
  url: 'https://model.example.com',
  isSystem: 0,
})
const binding = (source: Model = custom): CloudConnectionView => ({
  record: {
    id: 'cloud-model-grant',
    ownerId: 'owner',
    version: 1,
    keyEpoch: 1,
    enabled: true,
    status: 'unverified',
    config: { version: 1, kind: 'scoped-payload', iv: '', ciphertext: '' },
    ownerKeyEnvelope: {
      version: 1,
      kind: 'resource-key',
      recipientKeyId: '',
      ephemeralPublicKey: '',
      mlkemCiphertext: '',
      iv: '',
      ciphertext: '',
    },
    updatedAt: '2026-10-23T00:00:00Z',
    deletedAt: null,
  },
  config: {
    name: source.name,
    kind: 'model',
    libraryRef: { kind: 'model', id: source.id },
    url: modelCloudEndpoint(source)!,
    authentication: { type: 'bearer', token: 'CLOUD-ONLY-SECRET' },
    modelLimits: { contextWindow: 32768, maxOutputTokens: 4096, inputCostPerMillion: 1, outputCostPerMillion: 2 },
  },
})
const skill = (id: string, changes: Partial<Skill> = {}): Skill => ({
  id,
  name: 'review',
  label: 'Review',
  description: 'Review work',
  instruction: 'Full instruction text',
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: 'owner',
  ...changes,
})

describe('cloud model library resolution', () => {
  it('uses the selected managed library identity without silently substituting another model', () => {
    expect(resolveCloudModel(model(), { managedModel: managed })).toEqual({
      ok: true,
      model: { ...managed, sourceId: defaultModelDeepSeekV41Flash.id },
    })
    expect(resolveCloudModel(model({ model: 'another-model' }), { managedModel: managed })).toEqual({
      ok: false,
      code: 'managed_model_unavailable',
    })
    expect(resolveCloudModel(model(), { managedModel: null })).toEqual({ ok: false, code: 'managed_model_unavailable' })
  })

  it.each(['openai', 'openrouter', 'custom', 'anthropic'] as const)(
    'snapshots %s only through an explicit cloud credential binding',
    (provider) => {
      const source = model({ ...custom, provider })
      const resolved = resolveCloudModel(source, { managedModel: managed, binding: binding(source) })
      expect(resolved.ok).toBe(true)
      if (!resolved.ok) {
        throw new Error(resolved.code)
      }
      expect(resolved.model.sourceId).toBe(source.id)
      expect(resolved.model.connectionId).toBe('cloud-model-grant')
      expect(resolved.model.provider).toBe(provider === 'anthropic' ? 'anthropic' : 'openai-compatible')
      expect(resolved.model.inputCostPerMillion).toBe(1)
      expect(JSON.stringify(resolved.model)).not.toContain('SECRET')
      expect(resolveCloudModel(source, { managedModel: managed })).toEqual({
        ok: false,
        code: 'model_connection_required',
      })
    },
  )

  it('rejects a changed endpoint, changed source identity, or revoked connection', () => {
    const granted = binding()
    expect(
      resolveCloudModel({ ...custom, url: 'https://another.example.com' }, { managedModel: managed, binding: granted }),
    ).toEqual({ ok: false, code: 'model_connection_changed' })
    expect(resolveCloudModel({ ...custom, id: 'renamed-row' }, { managedModel: managed, binding: granted })).toEqual({
      ok: false,
      code: 'model_connection_changed',
    })
    expect(
      resolveCloudModel(custom, {
        managedModel: managed,
        binding: { ...granted, record: { ...granted.record, enabled: false } },
      }),
    ).toEqual({ ok: false, code: 'model_connection_unavailable' })
    expect(
      resolveCloudModel(custom, {
        managedModel: managed,
        binding: { ...granted, config: { ...granted.config, libraryRef: undefined } },
      }),
    ).toEqual({ ok: false, code: 'model_connection_changed' })
  })

  it('requires valid recorded cloud prices and limits rather than inventing them from the library', () => {
    const granted = binding()
    expect(
      resolveCloudModel(custom, {
        managedModel: managed,
        binding: { ...granted, config: { ...granted.config, modelLimits: undefined } },
      }),
    ).toEqual({ ok: false, code: 'model_limits_required' })
    for (const limits of [
      { ...granted.config.modelLimits!, inputCostPerMillion: 0 },
      { ...granted.config.modelLimits!, maxOutputTokens: 32768 },
    ]) {
      expect(
        resolveCloudModel(custom, {
          managedModel: managed,
          binding: { ...granted, config: { ...granted.config, modelLimits: limits } },
        }),
      ).toEqual({ ok: false, code: 'model_limits_required' })
    }
  })

  it('does not offer local endpoints, unsupported providers, deleted models, or models without tools', () => {
    expect(modelCloudEndpoint({ provider: 'custom', url: 'http://localhost:1234' })).toBeNull()
    expect(modelCloudEndpoint({ provider: 'custom', url: 'https://127.0.0.1:1234' })).toBeNull()
    expect(modelCloudEndpoint({ provider: 'custom', url: 'https://model.example.com?token=private' })).toBeNull()
    expect(resolveCloudModel(model({ provider: 'thunderbolt' }), { managedModel: managed })).toEqual({
      ok: false,
      code: 'model_provider_unsupported',
    })
    expect(resolveCloudModel(model({ toolUsage: 0 }), { managedModel: managed })).toEqual({
      ok: false,
      code: 'model_tools_unsupported',
    })
    expect(resolveCloudModel(model({ deletedAt: '2026-10-23' }), { managedModel: managed })).toEqual({
      ok: false,
      code: 'model_deleted',
    })
    expect(cloudModelSchema.parse(managed).sourceId).toBeUndefined()
  })
})

describe('cloud skill library snapshots', () => {
  it('selects by stable ID and snapshots current full instructions despite rename or global chat disable', () => {
    const current = skill('chosen', { name: 'renamed-skill', instruction: 'New complete instruction', enabled: 0 })
    const other = skill('other', { name: 'original-skill', instruction: 'Wrong instruction' })
    expect(resolveCloudSkills(['chosen', 'chosen'], [current, other])).toEqual([
      {
        sourceId: 'chosen',
        name: 'renamed-skill',
        description: 'Review work',
        instruction: 'New complete instruction',
      },
    ])
  })

  it('preserves legacy snapshots explicitly and never attaches them by matching display name', () => {
    const legacy = { name: 'review', description: 'Old description', instruction: 'Frozen old instruction' }
    const selection = cloudSkillSelection([legacy, { ...legacy, sourceId: 'chosen' }])
    expect(selection).toEqual({ ids: ['chosen'], legacy: [legacy] })
    expect(resolveCloudSkills([], [skill('same-name')], selection.legacy)).toEqual([legacy])
    expect(cloudAgentConfigSchema.shape.skills.parse([legacy])).toEqual([legacy])
  })

  it('refuses missing, deleted, or instructionless selected skills instead of silently dropping them', () => {
    expect(() => resolveCloudSkills(['missing'], [])).toThrow('skill_missing')
    expect(() => resolveCloudSkills(['deleted'], [skill('deleted', { deletedAt: '2026-10-23' })])).toThrow(
      'skill_missing',
    )
    expect(() => resolveCloudSkills(['empty'], [skill('empty', { instruction: '  ' })])).toThrow(
      'skill_instruction_missing',
    )
  })
})

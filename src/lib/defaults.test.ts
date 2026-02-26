import type { Model } from '@/types'
import { describe, expect, test } from 'bun:test'
import { defaultAutomations, hashPrompt } from '../defaults/automations'
import { defaultModels, hashModel } from '../defaults/models'
import { defaultSettings, hashSetting } from '../defaults/settings'

describe('defaults', () => {
  test('defaultModels has expected structure', () => {
    expect(defaultModels.length).toBeGreaterThan(0)
    for (const model of defaultModels) {
      expect(model.id).toBeDefined()
      expect(model.name).toBeDefined()
      expect(model.provider).toBeDefined()
      expect(model.model).toBeDefined()
      expect(model.deletedAt).toBeNull()
      expect(model.defaultHash).toBeNull()
      expect(model.apiKey).toBeNull()
      expect(model.url).toBeNull()
    }
  })

  test('defaultAutomations has expected structure', () => {
    expect(defaultAutomations.length).toBeGreaterThan(0)
    for (const automation of defaultAutomations) {
      expect(automation.id).toBeDefined()
      expect(automation.title).toBeDefined()
      expect(automation.prompt).toBeDefined()
      expect(automation.deletedAt).toBeNull()
      expect(automation.defaultHash).toBeNull()
      expect(automation.modelId).toBeDefined()
    }
  })

  test('defaultSettings has expected structure', () => {
    expect(defaultSettings.length).toBeGreaterThan(0)
    for (const setting of defaultSettings) {
      expect(setting.key).toBeDefined()
      expect(setting.value).toBeDefined()
      expect(setting.defaultHash).toBeNull()
    }
  })
})

describe('defaults-hash', () => {
  test('hashModel produces consistent hashes', () => {
    const model = defaultModels[0]
    const hash1 = hashModel(model)
    const hash2 = hashModel(model)
    expect(hash1).toBe(hash2)
  })

  test('hashModel detects changes in any field', () => {
    const model = defaultModels[0]
    const originalHash = hashModel(model)

    // Test various field changes
    const nameChange = hashModel({ ...model, name: 'Different' })
    const enabledChange = hashModel({ ...model, enabled: model.enabled === 1 ? 0 : 1 })
    const providerChange = hashModel({ ...model, provider: 'custom' })

    expect(originalHash).not.toBe(nameChange)
    expect(originalHash).not.toBe(enabledChange)
    expect(originalHash).not.toBe(providerChange)
    expect(nameChange).not.toBe(enabledChange)
  })

  test('hashModel ignores order of object creation', () => {
    const model = defaultModels[0]
    // Create model with same values but different property order
    const reorderedModel: Model = {
      contextWindow: model.contextWindow,
      name: model.name,
      enabled: model.enabled,
      provider: model.provider,
      model: model.model,
      url: model.url,
      apiKey: model.apiKey,
      isSystem: model.isSystem,
      toolUsage: model.toolUsage,
      isConfidential: model.isConfidential,
      startWithReasoning: model.startWithReasoning,
      supportsParallelToolCalls: model.supportsParallelToolCalls,
      id: model.id,
      deletedAt: model.deletedAt,
      defaultHash: model.defaultHash,
      vendor: model.vendor,
      description: model.description,
      userId: model.userId,
    }
    expect(hashModel(model)).toBe(hashModel(reorderedModel))
  })

  test('hashPrompt produces consistent hashes', () => {
    const prompt = defaultAutomations[0]
    const hash1 = hashPrompt(prompt)
    const hash2 = hashPrompt(prompt)
    expect(hash1).toBe(hash2)
  })

  test('hashPrompt detects changes in any field', () => {
    const prompt = defaultAutomations[0]
    const originalHash = hashPrompt(prompt)

    const titleChange = hashPrompt({ ...prompt, title: 'Different Title' })
    const promptChange = hashPrompt({ ...prompt, prompt: 'Different content' })
    const modelIdChange = hashPrompt({ ...prompt, modelId: 'different-id' })

    expect(originalHash).not.toBe(titleChange)
    expect(originalHash).not.toBe(promptChange)
    expect(originalHash).not.toBe(modelIdChange)
  })

  test('hashPrompt handles null title', () => {
    const prompt = defaultAutomations[0]
    const withNull = { ...prompt, title: null }
    const withString = { ...prompt, title: 'Some Title' }

    const hash1 = hashPrompt(withNull)
    const hash2 = hashPrompt(withString)

    expect(hash1).not.toBe(hash2)
  })

  test('hash computation is deterministic for models', () => {
    for (const model of defaultModels) {
      const hash1 = hashModel(model)
      const hash2 = hashModel(model)
      expect(hash1).toBe(hash2)
      expect(hash1).toBeDefined()
    }
  })

  test('hash computation is deterministic for automations', () => {
    for (const automation of defaultAutomations) {
      const hash1 = hashPrompt(automation)
      const hash2 = hashPrompt(automation)
      expect(hash1).toBe(hash2)
      expect(hash1).toBeDefined()
    }
  })

  test('hash detects round-trip modification', () => {
    // Simulate: Original → Modified → Back to Original
    const model = defaultModels[0]
    const originalHash = hashModel(model)

    // Modify
    const modified = { ...model, name: 'Modified' }
    const modifiedHash = hashModel(modified)
    expect(modifiedHash).not.toBe(originalHash)

    // Change back
    const restored = { ...modified, name: model.name }
    const restoredHash = hashModel(restored)
    expect(restoredHash).toBe(originalHash)
  })

  test('hashSetting produces consistent hashes', () => {
    const setting = defaultSettings[0]
    const hash1 = hashSetting(setting)
    const hash2 = hashSetting(setting)
    expect(hash1).toBe(hash2)
  })

  test('hashSetting detects changes in value', () => {
    const setting = defaultSettings[0]
    const originalHash = hashSetting(setting)

    const valueChange = hashSetting({ ...setting, value: 'different_value' })

    expect(originalHash).not.toBe(valueChange)
  })

  test('hash computation is deterministic for settings', () => {
    for (const setting of defaultSettings) {
      const hash1 = hashSetting(setting)
      const hash2 = hashSetting(setting)
      expect(hash1).toBe(hash2)
      expect(hash1).toBeDefined()
    }
  })
})

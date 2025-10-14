import { describe, expect, test } from 'bun:test'
import { defaultAutomations, defaultModels } from './defaults'
import { getDefaultById, hasUserModifications, isDefault } from './defaults-diff'

describe('defaults', () => {
  test('defaultModels has expected structure', () => {
    expect(defaultModels.length).toBeGreaterThan(0)
    for (const model of defaultModels) {
      expect(model.id).toBeDefined()
      expect(model.name).toBeDefined()
      expect(model.provider).toBeDefined()
      expect(model.model).toBeDefined()
      expect(model.deletedAt).toBeNull()
    }
  })

  test('defaultAutomations has expected structure', () => {
    expect(defaultAutomations.length).toBeGreaterThan(0)
    for (const automation of defaultAutomations) {
      expect(automation.id).toBeDefined()
      expect(automation.title).toBeDefined()
      expect(automation.prompt).toBeDefined()
      expect(automation.deletedAt).toBeNull()
    }
  })
})

describe('defaults-diff', () => {
  test('isDefault returns true for default items', () => {
    const defaultId = defaultModels[0].id
    expect(isDefault(defaultId, defaultModels)).toBe(true)
  })

  test('isDefault returns false for non-default items', () => {
    expect(isDefault('non-existent-id', defaultModels)).toBe(false)
  })

  test('hasUserModifications returns false for unchanged items', () => {
    const defaultModel = defaultModels[0]
    expect(hasUserModifications(defaultModel, defaultModels)).toBe(false)
  })

  test('hasUserModifications returns true for modified items', () => {
    const defaultModel = defaultModels[0]
    const modifiedModel = { ...defaultModel, name: 'Modified Name' }
    expect(hasUserModifications(modifiedModel, defaultModels)).toBe(true)
  })

  test('hasUserModifications returns false for user-created items', () => {
    const userModel: (typeof defaultModels)[number] = {
      id: 'user-created-id',
      name: 'User Model',
      provider: 'custom',
      model: 'custom-model',
      isSystem: 0,
      enabled: 1,
      isConfidential: 0,
      contextWindow: 4096,
      toolUsage: 1,
      startWithReasoning: 0,
      deletedAt: null,
      apiKey: null,
      url: null,
    }
    expect(hasUserModifications(userModel, defaultModels)).toBe(false)
  })

  test('getDefaultById returns the correct default', () => {
    const defaultId = defaultModels[0].id
    const result = getDefaultById(defaultId, defaultModels)
    expect(result).toBeDefined()
    expect(result?.id).toBe(defaultId)
  })

  test('getDefaultById returns undefined for non-existent id', () => {
    const result = getDefaultById('non-existent-id', defaultModels)
    expect(result).toBeUndefined()
  })
})

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { modelProfilesTable, modelsTable } from '@/db/tables'
import { defaultModelOpus48 } from '@/defaults/models'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import {
  createDefaultModelProfile,
  deleteModelProfileForModel,
  getModelProfile,
  resetModelProfileToDefault,
  upsertModelProfile,
} from './model-profiles'
import { otherWsId, resetTestDatabase, setupTestDatabase, teardownTestDatabase, wsId } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('Model Profiles DAL', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  describe('getModelProfile', () => {
    it('should return null for non-existent model', async () => {
      const profile = await getModelProfile(getDb(), wsId, 'nonexistent-model-id')
      expect(profile).toBe(null)
    })

    it('should return profile when it exists', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      await db.insert(modelProfilesTable).values({
        modelId,
        temperature: 0.5,
        maxSteps: 10,
        workspaceId: wsId,
      })

      const profile = await getModelProfile(getDb(), wsId, modelId)
      expect(profile).not.toBe(null)
      expect(profile?.modelId).toBe(modelId)
      expect(profile?.temperature).toBe(0.5)
      expect(profile?.maxSteps).toBe(10)
    })

    it('should exclude soft-deleted profiles', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      await db.insert(modelProfilesTable).values({
        modelId,
        temperature: 0.5,
        deletedAt: new Date().toISOString(),
        workspaceId: wsId,
      })

      const profile = await getModelProfile(getDb(), wsId, modelId)
      expect(profile).toBe(null)
    })
  })

  describe('upsertModelProfile', () => {
    it('should insert a new profile', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      await upsertModelProfile(getDb(), wsId, { modelId, temperature: 0.7, maxSteps: 15 })

      const profile = await getModelProfile(getDb(), wsId, modelId)
      expect(profile).not.toBe(null)
      expect(profile?.modelId).toBe(modelId)
      expect(profile?.temperature).toBe(0.7)
      expect(profile?.maxSteps).toBe(15)
    })

    it('should update an existing profile', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      await db.insert(modelProfilesTable).values({
        modelId,
        temperature: 0.2,
        maxSteps: 5,
        workspaceId: wsId,
      })

      await upsertModelProfile(getDb(), wsId, { modelId, temperature: 0.9, maxSteps: 20 })

      const profile = await getModelProfile(getDb(), wsId, modelId)
      expect(profile?.temperature).toBe(0.9)
      expect(profile?.maxSteps).toBe(20)

      // Ensure only one record exists
      const allProfiles = await db.select().from(modelProfilesTable).where(eq(modelProfilesTable.modelId, modelId))
      expect(allProfiles).toHaveLength(1)
    })
  })

  describe('deleteModelProfileForModel', () => {
    it('should soft-delete the profile', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      await db.insert(modelProfilesTable).values({
        modelId,
        temperature: 0.3,
        workspaceId: wsId,
      })

      // Verify profile exists before deletion
      const profileBefore = await getModelProfile(getDb(), wsId, modelId)
      expect(profileBefore).not.toBe(null)

      await deleteModelProfileForModel(getDb(), wsId, modelId)

      // Profile should not be returned by getModelProfile
      const profileAfter = await getModelProfile(getDb(), wsId, modelId)
      expect(profileAfter).toBe(null)

      // But record should still exist in database with deletedAt set
      const rawProfile = await db.select().from(modelProfilesTable).where(eq(modelProfilesTable.modelId, modelId)).get()
      expect(rawProfile).not.toBeUndefined()
      expect(rawProfile?.deletedAt).not.toBeNull()
    })

    it('should preserve original deletedAt for already-deleted profiles', async () => {
      const db = getDb()
      const modelId = uuidv7()
      const originalDeletedAt = new Date(Date.now() - 10000).toISOString()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      await db.insert(modelProfilesTable).values({
        modelId,
        temperature: 0.3,
        deletedAt: originalDeletedAt,
        workspaceId: wsId,
      })

      // Call delete again on already-deleted profile
      await deleteModelProfileForModel(getDb(), wsId, modelId)

      // Verify original deletedAt is preserved
      const rawProfile = await db.select().from(modelProfilesTable).where(eq(modelProfilesTable.modelId, modelId)).get()
      expect(rawProfile?.deletedAt).toBe(originalDeletedAt)
    })
  })

  describe('resetModelProfileToDefault', () => {
    it('should restore default values for a known model', async () => {
      const db = getDb()
      const { defaultModelProfileOpus48 } = await import('@/defaults/model-profiles')

      // Insert the actual default model first to satisfy FK constraint
      await db.insert(modelsTable).values({
        id: defaultModelOpus48.id,
        provider: defaultModelOpus48.provider,
        name: defaultModelOpus48.name,
        model: defaultModelOpus48.model,
        isSystem: defaultModelOpus48.isSystem,
        enabled: defaultModelOpus48.enabled,
        workspaceId: wsId,
      })

      // Insert a profile with modified values
      await db.insert(modelProfilesTable).values({
        modelId: defaultModelOpus48.id,
        temperature: 0.99,
        maxSteps: 1,
        deletedAt: new Date().toISOString(),
        workspaceId: wsId,
      })

      // Reset to defaults
      await resetModelProfileToDefault(getDb(), wsId, defaultModelOpus48.id)

      const profile = await getModelProfile(getDb(), wsId, defaultModelOpus48.id)
      expect(profile).not.toBe(null)
      expect(profile?.temperature).toBe(defaultModelProfileOpus48.temperature)
      expect(profile?.maxSteps).toBe(defaultModelProfileOpus48.maxSteps)
      expect(profile?.maxAttempts).toBe(defaultModelProfileOpus48.maxAttempts)
      expect(profile?.nudgeThreshold).toBe(defaultModelProfileOpus48.nudgeThreshold)
      expect(profile?.deletedAt).toBe(null)
    })

    it('should do nothing for a model without a default profile', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Custom Model',
        model: 'custom-model',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      await db.insert(modelProfilesTable).values({
        modelId,
        temperature: 0.5,
        workspaceId: wsId,
      })

      // Should not throw, and should not modify the profile
      await resetModelProfileToDefault(getDb(), wsId, modelId)

      const profile = await getModelProfile(getDb(), wsId, modelId)
      expect(profile?.temperature).toBe(0.5)
    })
  })

  describe('createDefaultModelProfile', () => {
    it('should create a profile for a known default model', async () => {
      const db = getDb()
      const { defaultModelProfileOpus48, hashModelProfile } = await import('@/defaults/model-profiles')

      await db.insert(modelsTable).values({
        id: defaultModelOpus48.id,
        provider: defaultModelOpus48.provider,
        name: defaultModelOpus48.name,
        model: defaultModelOpus48.model,
        isSystem: defaultModelOpus48.isSystem,
        enabled: defaultModelOpus48.enabled,
        workspaceId: wsId,
      })

      await createDefaultModelProfile(getDb(), wsId, defaultModelOpus48.id)

      const profile = await getModelProfile(getDb(), wsId, defaultModelOpus48.id)
      expect(profile).not.toBe(null)
      expect(profile?.modelId).toBe(defaultModelOpus48.id)
      expect(profile?.temperature).toBe(defaultModelProfileOpus48.temperature)

      // Should store the defaultHash
      const rawProfile = await db
        .select()
        .from(modelProfilesTable)
        .where(eq(modelProfilesTable.modelId, defaultModelOpus48.id))
        .get()
      expect(rawProfile?.defaultHash).toBe(hashModelProfile(defaultModelProfileOpus48))
    })

    it('should do nothing for a model without seed data', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Custom Model',
        model: 'custom-model',
        isSystem: 0,
        enabled: 1,
        workspaceId: wsId,
      })

      await createDefaultModelProfile(getDb(), wsId, modelId)

      const profile = await getModelProfile(getDb(), wsId, modelId)
      expect(profile).toBe(null)
    })

    it('should not overwrite an existing profile (onConflictDoNothing)', async () => {
      const db = getDb()

      await db.insert(modelsTable).values({
        id: defaultModelOpus48.id,
        provider: defaultModelOpus48.provider,
        name: defaultModelOpus48.name,
        model: defaultModelOpus48.model,
        isSystem: defaultModelOpus48.isSystem,
        enabled: defaultModelOpus48.enabled,
        workspaceId: wsId,
      })

      // Insert a custom profile first
      await db.insert(modelProfilesTable).values({
        modelId: defaultModelOpus48.id,
        temperature: 0.99,
        workspaceId: wsId,
      })

      // Calling createDefaultModelProfile should not overwrite
      await createDefaultModelProfile(getDb(), wsId, defaultModelOpus48.id)

      const profile = await getModelProfile(getDb(), wsId, defaultModelOpus48.id)
      expect(profile?.temperature).toBe(0.99)
    })
  })

  describe('workspace isolation', () => {
    it('should not return a profile from another workspace', async () => {
      const db = getDb()
      const modelId = uuidv7()

      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Other Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
        workspaceId: otherWsId,
      })

      await db.insert(modelProfilesTable).values({
        modelId,
        temperature: 0.5,
        workspaceId: otherWsId,
      })

      const profile = await getModelProfile(getDb(), wsId, modelId)
      expect(profile).toBe(null)
    })
  })
})

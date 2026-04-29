/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { modelProfilesTable, modelsTable } from '@/db/tables'
import { defaultModelGptOss120b } from '@/defaults/models'
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
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

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
      const profile = await getModelProfile(getDb(), 'nonexistent-model-id')
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
      })

      await db.insert(modelProfilesTable).values({
        modelId,
        temperature: 0.5,
        maxSteps: 10,
      })

      const profile = await getModelProfile(getDb(), modelId)
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
      })

      await db.insert(modelProfilesTable).values({
        modelId,
        temperature: 0.5,
        deletedAt: new Date().toISOString(),
      })

      const profile = await getModelProfile(getDb(), modelId)
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
      })

      await upsertModelProfile(getDb(), { modelId, temperature: 0.7, maxSteps: 15 })

      const profile = await getModelProfile(getDb(), modelId)
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
      })

      await db.insert(modelProfilesTable).values({
        modelId,
        temperature: 0.2,
        maxSteps: 5,
      })

      await upsertModelProfile(getDb(), { modelId, temperature: 0.9, maxSteps: 20 })

      const profile = await getModelProfile(getDb(), modelId)
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
      })

      await db.insert(modelProfilesTable).values({
        modelId,
        temperature: 0.3,
      })

      // Verify profile exists before deletion
      const profileBefore = await getModelProfile(getDb(), modelId)
      expect(profileBefore).not.toBe(null)

      await deleteModelProfileForModel(getDb(), modelId)

      // Profile should not be returned by getModelProfile
      const profileAfter = await getModelProfile(getDb(), modelId)
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
      })

      await db.insert(modelProfilesTable).values({
        modelId,
        temperature: 0.3,
        deletedAt: originalDeletedAt,
      })

      // Call delete again on already-deleted profile
      await deleteModelProfileForModel(getDb(), modelId)

      // Verify original deletedAt is preserved
      const rawProfile = await db.select().from(modelProfilesTable).where(eq(modelProfilesTable.modelId, modelId)).get()
      expect(rawProfile?.deletedAt).toBe(originalDeletedAt)
    })
  })

  describe('resetModelProfileToDefault', () => {
    it('should restore default values for a known model', async () => {
      const db = getDb()
      const { defaultModelProfileGptOss120b } = await import('@/defaults/model-profiles')

      // Insert the actual default model first to satisfy FK constraint
      await db.insert(modelsTable).values({
        id: defaultModelGptOss120b.id,
        provider: defaultModelGptOss120b.provider,
        name: defaultModelGptOss120b.name,
        model: defaultModelGptOss120b.model,
        isSystem: defaultModelGptOss120b.isSystem,
        enabled: defaultModelGptOss120b.enabled,
      })

      // Insert a profile with modified values
      await db.insert(modelProfilesTable).values({
        modelId: defaultModelGptOss120b.id,
        temperature: 0.99,
        maxSteps: 1,
        deletedAt: new Date().toISOString(),
      })

      // Reset to defaults
      await resetModelProfileToDefault(getDb(), defaultModelGptOss120b.id)

      const profile = await getModelProfile(getDb(), defaultModelGptOss120b.id)
      expect(profile).not.toBe(null)
      expect(profile?.temperature).toBe(defaultModelProfileGptOss120b.temperature)
      expect(profile?.maxSteps).toBe(defaultModelProfileGptOss120b.maxSteps)
      expect(profile?.maxAttempts).toBe(defaultModelProfileGptOss120b.maxAttempts)
      expect(profile?.nudgeThreshold).toBe(defaultModelProfileGptOss120b.nudgeThreshold)
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
      })

      await db.insert(modelProfilesTable).values({
        modelId,
        temperature: 0.5,
      })

      // Should not throw, and should not modify the profile
      await resetModelProfileToDefault(getDb(), modelId)

      const profile = await getModelProfile(getDb(), modelId)
      expect(profile?.temperature).toBe(0.5)
    })
  })

  describe('createDefaultModelProfile', () => {
    it('should create a profile for a known default model', async () => {
      const db = getDb()
      const { defaultModelProfileGptOss120b, hashModelProfile } = await import('@/defaults/model-profiles')

      await db.insert(modelsTable).values({
        id: defaultModelGptOss120b.id,
        provider: defaultModelGptOss120b.provider,
        name: defaultModelGptOss120b.name,
        model: defaultModelGptOss120b.model,
        isSystem: defaultModelGptOss120b.isSystem,
        enabled: defaultModelGptOss120b.enabled,
      })

      await createDefaultModelProfile(getDb(), defaultModelGptOss120b.id)

      const profile = await getModelProfile(getDb(), defaultModelGptOss120b.id)
      expect(profile).not.toBe(null)
      expect(profile?.modelId).toBe(defaultModelGptOss120b.id)
      expect(profile?.temperature).toBe(defaultModelProfileGptOss120b.temperature)

      // Should store the defaultHash
      const rawProfile = await db
        .select()
        .from(modelProfilesTable)
        .where(eq(modelProfilesTable.modelId, defaultModelGptOss120b.id))
        .get()
      expect(rawProfile?.defaultHash).toBe(hashModelProfile(defaultModelProfileGptOss120b))
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
      })

      await createDefaultModelProfile(getDb(), modelId)

      const profile = await getModelProfile(getDb(), modelId)
      expect(profile).toBe(null)
    })

    it('should not overwrite an existing profile (onConflictDoNothing)', async () => {
      const db = getDb()

      await db.insert(modelsTable).values({
        id: defaultModelGptOss120b.id,
        provider: defaultModelGptOss120b.provider,
        name: defaultModelGptOss120b.name,
        model: defaultModelGptOss120b.model,
        isSystem: defaultModelGptOss120b.isSystem,
        enabled: defaultModelGptOss120b.enabled,
      })

      // Insert a custom profile first
      await db.insert(modelProfilesTable).values({
        modelId: defaultModelGptOss120b.id,
        temperature: 0.99,
      })

      // Calling createDefaultModelProfile should not overwrite
      await createDefaultModelProfile(getDb(), defaultModelGptOss120b.id)

      const profile = await getModelProfile(getDb(), defaultModelGptOss120b.id)
      expect(profile?.temperature).toBe(0.99)
    })
  })
})

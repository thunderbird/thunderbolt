/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { modesTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { nowIso } from '@/lib/utils'
import { getAllModes, getDefaultMode, getMode, getSelectedMode } from './modes'
import { updateSettings } from './settings'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('Modes DAL', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  describe('getMode', () => {
    it('should return null when mode does not exist', async () => {
      const mode = await getMode(getDb(), 'nonexistent-mode-id')
      expect(mode).toBe(null)
    })

    it('should return mode when it exists', async () => {
      const db = getDb()
      const modeId = uuidv7()

      await db.insert(modesTable).values({
        id: modeId,
        name: 'test',
        label: 'Test Mode',
        icon: 'message-square',
        isDefault: 0,
        order: 0,
      })

      const mode = await getMode(getDb(), modeId)
      expect(mode).not.toBe(null)
      expect(mode?.id).toBe(modeId)
      expect(mode?.label).toBe('Test Mode')
    })

    it('should return null for soft-deleted mode', async () => {
      const db = getDb()
      const modeId = uuidv7()

      await db.insert(modesTable).values({
        id: modeId,
        name: 'deleted',
        label: 'Deleted Mode',
        icon: 'message-square',
        isDefault: 0,
        order: 0,
        deletedAt: nowIso(),
      })

      const mode = await getMode(getDb(), modeId)
      expect(mode).toBe(null)
    })
  })

  describe('getDefaultMode', () => {
    it('should return null when no default mode exists', async () => {
      const mode = await getDefaultMode(getDb())
      expect(mode).toBe(null)
    })

    it('should return the default mode when it exists', async () => {
      const db = getDb()
      const modeId = uuidv7()

      await db.insert(modesTable).values({
        id: modeId,
        name: 'chat',
        label: 'Chat',
        icon: 'message-square',
        isDefault: 1,
        order: 0,
      })

      const mode = await getDefaultMode(getDb())
      expect(mode).not.toBe(null)
      expect(mode?.id).toBe(modeId)
      expect(mode?.isDefault).toBe(1)
    })

    it('should return null when default mode is soft-deleted', async () => {
      const db = getDb()

      await db.insert(modesTable).values({
        id: uuidv7(),
        name: 'chat',
        label: 'Chat',
        icon: 'message-square',
        isDefault: 1,
        order: 0,
        deletedAt: nowIso(),
      })

      const mode = await getDefaultMode(getDb())
      expect(mode).toBe(null)
    })
  })

  describe('getAllModes', () => {
    it('should return empty array when no modes exist', async () => {
      const modes = await getAllModes(getDb())
      expect(modes).toEqual([])
    })

    it('should return all modes sorted by order', async () => {
      const db = getDb()

      await db.insert(modesTable).values([
        { id: uuidv7(), name: 'research', label: 'Research', icon: 'microscope', isDefault: 0, order: 2 },
        { id: uuidv7(), name: 'chat', label: 'Chat', icon: 'message-square', isDefault: 1, order: 0 },
        { id: uuidv7(), name: 'search', label: 'Search', icon: 'globe', isDefault: 0, order: 1 },
      ])

      const modes = await getAllModes(getDb())
      expect(modes.length).toBe(3)
      expect(modes[0].name).toBe('chat')
      expect(modes[1].name).toBe('search')
      expect(modes[2].name).toBe('research')
    })

    it('should exclude soft-deleted modes', async () => {
      const db = getDb()

      await db.insert(modesTable).values([
        { id: uuidv7(), name: 'chat', label: 'Chat', icon: 'message-square', isDefault: 1, order: 0 },
        {
          id: uuidv7(),
          name: 'deleted',
          label: 'Deleted',
          icon: 'trash',
          isDefault: 0,
          order: 1,
          deletedAt: nowIso(),
        },
      ])

      const modes = await getAllModes(getDb())
      expect(modes.length).toBe(1)
      expect(modes[0].name).toBe('chat')
    })
  })

  describe('getSelectedMode', () => {
    it('should return default mode when no selected_mode setting exists', async () => {
      const db = getDb()
      const modeId = uuidv7()

      await db.insert(modesTable).values({
        id: modeId,
        name: 'chat',
        label: 'Chat',
        icon: 'message-square',
        isDefault: 1,
        order: 0,
      })

      const mode = await getSelectedMode(getDb())
      expect(mode.id).toBe(modeId)
      expect(mode.isDefault).toBe(1)
    })

    it('should return selected mode when setting exists', async () => {
      const db = getDb()

      const defaultModeId = uuidv7()
      const selectedModeId = uuidv7()

      await db.insert(modesTable).values([
        { id: defaultModeId, name: 'chat', label: 'Chat', icon: 'message-square', isDefault: 1, order: 0 },
        { id: selectedModeId, name: 'search', label: 'Search', icon: 'globe', isDefault: 0, order: 1 },
      ])

      await updateSettings(getDb(), { selected_mode: selectedModeId })

      const mode = await getSelectedMode(getDb())
      expect(mode.id).toBe(selectedModeId)
      expect(mode.name).toBe('search')
    })

    it('should fall back to default mode when selected mode does not exist', async () => {
      const db = getDb()
      const defaultModeId = uuidv7()

      await db.insert(modesTable).values({
        id: defaultModeId,
        name: 'chat',
        label: 'Chat',
        icon: 'message-square',
        isDefault: 1,
        order: 0,
      })

      await updateSettings(getDb(), { selected_mode: 'nonexistent-mode-id' })

      const mode = await getSelectedMode(getDb())
      expect(mode.id).toBe(defaultModeId)
    })

    it('should throw error when no default mode exists', async () => {
      expect(getSelectedMode(getDb())).rejects.toThrow('No default mode found')
    })
  })
})

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
import { otherWsId, resetTestDatabase, setupTestDatabase, teardownTestDatabase, wsId } from './test-utils'

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
      const mode = await getMode(getDb(), wsId, 'nonexistent-mode-id')
      expect(mode).toBe(null)
    })

    it('should return mode when it exists in the workspace', async () => {
      const db = getDb()
      const modeId = uuidv7()

      await db.insert(modesTable).values({
        id: modeId,
        name: 'test',
        label: 'Test Mode',
        icon: 'message-square',
        isDefault: 0,
        order: 0,
        workspaceId: wsId,
      })

      const mode = await getMode(getDb(), wsId, modeId)
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
        workspaceId: wsId,
      })

      const mode = await getMode(getDb(), wsId, modeId)
      expect(mode).toBe(null)
    })

    it('should not return a mode from another workspace', async () => {
      const db = getDb()
      const modeId = uuidv7()

      await db.insert(modesTable).values({
        id: modeId,
        name: 'other',
        label: 'Other',
        icon: 'globe',
        isDefault: 0,
        order: 0,
        workspaceId: otherWsId,
      })

      const mode = await getMode(getDb(), wsId, modeId)
      expect(mode).toBe(null)
    })
  })

  describe('getDefaultMode', () => {
    it('should return null when no default mode exists', async () => {
      const mode = await getDefaultMode(getDb(), wsId)
      expect(mode).toBe(null)
    })

    it('should return the default mode when it exists in the workspace', async () => {
      const db = getDb()
      const modeId = uuidv7()

      await db.insert(modesTable).values({
        id: modeId,
        name: 'chat',
        label: 'Chat',
        icon: 'message-square',
        isDefault: 1,
        order: 0,
        workspaceId: wsId,
      })

      const mode = await getDefaultMode(getDb(), wsId)
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
        workspaceId: wsId,
      })

      const mode = await getDefaultMode(getDb(), wsId)
      expect(mode).toBe(null)
    })

    it('should ignore the default mode of another workspace', async () => {
      const db = getDb()

      await db.insert(modesTable).values({
        id: uuidv7(),
        name: 'chat',
        label: 'Chat',
        icon: 'message-square',
        isDefault: 1,
        order: 0,
        workspaceId: otherWsId,
      })

      const mode = await getDefaultMode(getDb(), wsId)
      expect(mode).toBe(null)
    })
  })

  describe('getAllModes', () => {
    it('should return empty array when no modes exist', async () => {
      const modes = await getAllModes(getDb(), wsId)
      expect(modes).toEqual([])
    })

    it('should return all modes in the workspace sorted by order', async () => {
      const db = getDb()

      await db.insert(modesTable).values([
        {
          id: uuidv7(),
          name: 'research',
          label: 'Research',
          icon: 'microscope',
          isDefault: 0,
          order: 2,
          workspaceId: wsId,
        },
        {
          id: uuidv7(),
          name: 'chat',
          label: 'Chat',
          icon: 'message-square',
          isDefault: 1,
          order: 0,
          workspaceId: wsId,
        },
        { id: uuidv7(), name: 'search', label: 'Search', icon: 'globe', isDefault: 0, order: 1, workspaceId: wsId },
      ])

      const modes = await getAllModes(getDb(), wsId)
      expect(modes.length).toBe(3)
      expect(modes[0].name).toBe('chat')
      expect(modes[1].name).toBe('search')
      expect(modes[2].name).toBe('research')
    })

    it('should exclude soft-deleted modes', async () => {
      const db = getDb()

      await db.insert(modesTable).values([
        {
          id: uuidv7(),
          name: 'chat',
          label: 'Chat',
          icon: 'message-square',
          isDefault: 1,
          order: 0,
          workspaceId: wsId,
        },
        {
          id: uuidv7(),
          name: 'deleted',
          label: 'Deleted',
          icon: 'trash',
          isDefault: 0,
          order: 1,
          deletedAt: nowIso(),
          workspaceId: wsId,
        },
      ])

      const modes = await getAllModes(getDb(), wsId)
      expect(modes.length).toBe(1)
      expect(modes[0].name).toBe('chat')
    })

    it('should not return modes from other workspaces', async () => {
      const db = getDb()

      await db.insert(modesTable).values([
        {
          id: uuidv7(),
          name: 'own',
          label: 'Own',
          icon: 'message-square',
          isDefault: 0,
          order: 0,
          workspaceId: wsId,
        },
        {
          id: uuidv7(),
          name: 'other',
          label: 'Other',
          icon: 'globe',
          isDefault: 0,
          order: 1,
          workspaceId: otherWsId,
        },
      ])

      const modes = await getAllModes(getDb(), wsId)
      expect(modes.length).toBe(1)
      expect(modes[0].name).toBe('own')
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
        workspaceId: wsId,
      })

      const mode = await getSelectedMode(getDb(), wsId)
      expect(mode.id).toBe(modeId)
      expect(mode.isDefault).toBe(1)
    })

    it('should return selected mode when setting exists', async () => {
      const db = getDb()

      const defaultModeId = uuidv7()
      const selectedModeId = uuidv7()

      await db.insert(modesTable).values([
        {
          id: defaultModeId,
          name: 'chat',
          label: 'Chat',
          icon: 'message-square',
          isDefault: 1,
          order: 0,
          workspaceId: wsId,
        },
        {
          id: selectedModeId,
          name: 'search',
          label: 'Search',
          icon: 'globe',
          isDefault: 0,
          order: 1,
          workspaceId: wsId,
        },
      ])

      await updateSettings(getDb(), { selected_mode: selectedModeId })

      const mode = await getSelectedMode(getDb(), wsId)
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
        workspaceId: wsId,
      })

      await updateSettings(getDb(), { selected_mode: 'nonexistent-mode-id' })

      const mode = await getSelectedMode(getDb(), wsId)
      expect(mode.id).toBe(defaultModeId)
    })

    it('should throw error when no default mode exists', async () => {
      expect(getSelectedMode(getDb(), wsId)).rejects.toThrow('No default mode found')
    })

    it('should fall back to default mode when selected mode lives in another workspace', async () => {
      const db = getDb()
      const defaultModeId = uuidv7()
      const otherModeId = uuidv7()

      await db.insert(modesTable).values([
        {
          id: defaultModeId,
          name: 'chat',
          label: 'Chat',
          icon: 'message-square',
          isDefault: 1,
          order: 0,
          workspaceId: wsId,
        },
        {
          id: otherModeId,
          name: 'other',
          label: 'Other',
          icon: 'globe',
          isDefault: 0,
          order: 1,
          workspaceId: otherWsId,
        },
      ])

      // selected_mode points at a mode in another workspace — should fall back to the active default
      await updateSettings(getDb(), { selected_mode: otherModeId })

      const mode = await getSelectedMode(getDb(), wsId)
      expect(mode.id).toBe(defaultModeId)
    })
  })
})

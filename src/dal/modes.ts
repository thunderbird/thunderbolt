import { and, asc, eq, isNull } from 'drizzle-orm'
import { DatabaseSingleton } from '../db/singleton'
import { modesTable } from '../db/tables'
import type { Mode, ModeRow } from '../types'
import { getSettings } from './settings'

const mapMode = (row: ModeRow): Mode => row as Mode

/**
 * Gets all modes from the database (excluding soft-deleted)
 * Sorted by order field
 */
export const getAllModes = async (): Promise<Mode[]> => {
  const db = DatabaseSingleton.instance.db
  const results = await db.select().from(modesTable).where(isNull(modesTable.deletedAt)).orderBy(asc(modesTable.order))

  return results.map(mapMode)
}

/**
 * Gets the default mode
 */
export const getDefaultMode = async (): Promise<Mode | null> => {
  const db = DatabaseSingleton.instance.db
  const mode = await db
    .select()
    .from(modesTable)
    .where(and(eq(modesTable.isDefault, 1), isNull(modesTable.deletedAt)))
    .get()

  return mode ? mapMode(mode) : null
}

/**
 * Gets the currently selected mode from settings, or falls back to the default mode
 */
export const getSelectedMode = async (): Promise<Mode> => {
  const settings = await getSettings({ selected_mode: String })
  const selectedModeId = settings.selectedMode

  if (selectedModeId) {
    const mode = await getMode(selectedModeId)
    if (mode) return mode
  }

  const defaultMode = await getDefaultMode()

  if (!defaultMode) {
    throw new Error('No default mode found')
  }

  return defaultMode
}

/**
 * Gets a specific mode by ID (excluding soft-deleted)
 */
export const getMode = async (id: string): Promise<Mode | null> => {
  const db = DatabaseSingleton.instance.db
  const mode = await db
    .select()
    .from(modesTable)
    .where(and(eq(modesTable.id, id), isNull(modesTable.deletedAt)))
    .get()

  return mode ? mapMode(mode) : null
}

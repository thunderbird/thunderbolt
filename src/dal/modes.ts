/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, asc, eq, isNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { modesTable } from '../db/tables'
import type { Mode, ModeRow } from '../types'
import { getSettings } from './settings'

const mapMode = (row: ModeRow): Mode => row as Mode

/**
 * Gets all modes from the database (excluding soft-deleted)
 * Sorted by order field
 */
export const getAllModes = async (db: AnyDrizzleDatabase): Promise<Mode[]> => {
  const results = await db.select().from(modesTable).where(isNull(modesTable.deletedAt)).orderBy(asc(modesTable.order))

  return results.map(mapMode)
}

/**
 * Gets the default mode
 */
export const getDefaultMode = async (db: AnyDrizzleDatabase): Promise<Mode | null> => {
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
export const getSelectedMode = async (db: AnyDrizzleDatabase): Promise<Mode> => {
  const settings = await getSettings(db, { selected_mode: String })
  const selectedModeId = settings.selectedMode

  if (selectedModeId) {
    const mode = await getMode(db, selectedModeId)
    if (mode) {
      return mode
    }
  }

  const defaultMode = await getDefaultMode(db)

  if (!defaultMode) {
    throw new Error('No default mode found')
  }

  return defaultMode
}

/**
 * Gets a specific mode by ID (excluding soft-deleted)
 */
export const getMode = async (db: AnyDrizzleDatabase, id: string): Promise<Mode | null> => {
  const mode = await db
    .select()
    .from(modesTable)
    .where(and(eq(modesTable.id, id), isNull(modesTable.deletedAt)))
    .get()

  return mode ? mapMode(mode) : null
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq, sql } from 'drizzle-orm'
import { settingsTable } from '@/db/tables'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { nowIso } from '@/lib/utils'
import { artifactPresentationKeys } from '@/projects/artifact-presentation'
import { updateSettings } from './settings'

export const maxArtifactTitleLength = 200

/** Rename the saved artifact's presentation; its identity survives renaming and project moves. */
export const renameProjectArtifact = async (
  db: AnyDrizzleDatabase,
  artifactId: string,
  title: string,
): Promise<void> => {
  const trimmed = title.trim()
  if (!trimmed) {
    throw new Error('Artifact title is required')
  }
  await updateSettings(db, { [artifactPresentationKeys(artifactId).title]: trimmed.slice(0, maxArtifactTitleLength) })
}

/** Soft-delete a gallery entry, retaining the source output and unrelated artifacts in the same message. */
export const softDeleteProjectArtifact = async (db: AnyDrizzleDatabase, artifactId: string): Promise<void> => {
  await updateSettings(db, { [artifactPresentationKeys(artifactId).deletedAt]: nowIso() })
}

/** Include absent preference keys so callers can distinguish loaded defaults from metadata still loading. */
export const getArtifactPresentationRecords = (db: AnyDrizzleDatabase, keys: string[]) =>
  db
    .select({ key: sql<string>`artifact_keys.value`.as('key'), value: settingsTable.value })
    .from(sql`json_each(${JSON.stringify(keys)}) AS artifact_keys`)
    .leftJoin(settingsTable, eq(settingsTable.key, sql`artifact_keys.value`))

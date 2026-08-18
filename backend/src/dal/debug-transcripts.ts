/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { debugTranscriptsTable } from '@/db/debug-transcript-schema'

/** Persist one identified debug transcript. */
export const createDebugTranscript = async (
  database: typeof DbType,
  transcript: typeof debugTranscriptsTable.$inferInsert,
) => database.insert(debugTranscriptsTable).values(transcript)

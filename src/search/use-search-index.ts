/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CommonPowerSyncDatabase } from '@powersync/common'
import { usePowerSync } from '@powersync/react'
import { useEffect, useState } from 'react'
import { ensureSearchIndex } from './fts-setup'

type PreparationResult = {
  database: CommonPowerSyncDatabase
  enabled: boolean
  status: 'pending' | 'ready' | 'failed'
}

/** Prepares search only when requested, keeping chat startup independent of a backfill. */
export const useSearchIndex = (enabled: boolean) => {
  const database = usePowerSync()
  const [result, setResult] = useState<PreparationResult>({ database, enabled, status: 'pending' })
  const isCurrentRequest = result.database === database && result.enabled === enabled
  if (!isCurrentRequest) {
    setResult({ database, enabled, status: 'pending' })
  }

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    const prepare = async () => {
      try {
        await ensureSearchIndex(database)
        if (!cancelled) {
          setResult({ database, enabled, status: 'ready' })
        }
      } catch (error) {
        console.error('[search] Index preparation failed:', error)
        if (!cancelled) {
          setResult({ database, enabled, status: 'failed' })
        }
      }
    }
    void prepare()
    return () => {
      cancelled = true
    }
  }, [database, enabled])

  return isCurrentRequest ? result.status : 'pending'
}

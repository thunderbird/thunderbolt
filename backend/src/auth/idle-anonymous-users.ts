/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { deleteIdleAnonymousUsers } from '@/dal'
import type { QueryableDatabase } from '@/db/client'

type SweepLogger = {
  info: (context: Record<string, unknown>, message: string) => void
  error: (context: Record<string, unknown>, message: string) => void
}

/**
 * Purge anonymous users idle for more than `ANONYMOUS_USER_IDLE_DAYS` (startup + hourly, alongside
 * the nonce and captcha sweeps). A no-op when anonymous sign-in is off or the setting is 0. Logs a
 * failure instead of throwing, so the next sweep still runs.
 */
export const sweepIdleAnonymousUsers = async (
  database: QueryableDatabase,
  settings: Pick<Settings, 'authAllowAnonymous' | 'anonymousUserIdleDays'>,
  log: SweepLogger,
) => {
  if (!settings.authAllowAnonymous || settings.anonymousUserIdleDays === 0) {
    return
  }
  try {
    const deleted = await deleteIdleAnonymousUsers(database, settings.anonymousUserIdleDays)
    if (deleted > 0) {
      log.info({ deleted }, 'Purged idle anonymous users')
    }
  } catch (err) {
    log.error({ err }, 'Failed to sweep idle anonymous users')
  }
}

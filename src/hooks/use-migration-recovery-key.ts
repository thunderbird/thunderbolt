/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState } from 'react'

/**
 * Custom event carrying the NEW 24-word recovery phrase produced by the
 * seamless v1→v2 migration (WS6, run headlessly at app init). App init has no
 * render surface of its own, so it dispatches this event and a globally-mounted
 * listener shows the blocking recovery-phrase dialog — mirroring the
 * `show_revoked_device_modal` pattern.
 */
export const migrationRecoveryKeyEvent = 'e2ee_migration_recovery_key'

type MigrationRecoveryKeyDetail = { recoveryKey: string }

/** Dispatch the post-migration recovery phrase for the global listener to show. */
export const dispatchMigrationRecoveryKey = (recoveryKey: string): void => {
  window.dispatchEvent(
    new CustomEvent<MigrationRecoveryKeyDetail>(migrationRecoveryKeyEvent, { detail: { recoveryKey } }),
  )
}

/**
 * Listens for the post-migration recovery-phrase event and exposes the phrase
 * to render the blocking `RecoveryKeyDialog` in `App`. Shown exactly once — the
 * old phrase is already dead when the migration completes.
 */
export const useMigrationRecoveryKey = () => {
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)

  const handleEvent = useCallback((event: Event) => {
    const detail = (event as CustomEvent<MigrationRecoveryKeyDetail>).detail
    if (detail?.recoveryKey) {
      setRecoveryKey(detail.recoveryKey)
    }
  }, [])

  useEffect(() => {
    window.addEventListener(migrationRecoveryKeyEvent, handleEvent)
    return () => window.removeEventListener(migrationRecoveryKeyEvent, handleEvent)
  }, [handleEvent])

  const clear = useCallback(() => setRecoveryKey(null), [])

  return { migrationRecoveryKey: recoveryKey, clearMigrationRecoveryKey: clear }
}

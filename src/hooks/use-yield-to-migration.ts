/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react'
import { migrationRecoveryKeyEvent } from '@/hooks/use-migration-recovery-key'

type UseYieldToMigrationOptions = {
  /** Whether the surface that would compete with the migration dialog is open. */
  open: boolean
  /** True while that surface is showing a recovery phrase of its own. */
  isShowingOwnRecoveryKey: boolean
  /** Called to stand the competing surface down. */
  onYield: () => void
}

/**
 * Stand a blocking setup surface down when the seamless v1→v2 migration
 * finishes, so only one recovery-phrase dialog is ever on screen.
 *
 * The migration runs headlessly at app init and can land while the sync-setup
 * wizard is open (v1 account, user toggles sync at just the wrong moment). Both
 * surfaces block input, so they used to stack: the migration dialog on top of an
 * inert wizard the user still had to dismiss afterwards. The migration has
 * already achieved what the wizard exists to do, so the wizard yields.
 *
 * Yielding means SUCCEEDING, not cancelling — the caller is expected to run its
 * normal completion path. The migration provisioned this device's keys, which is
 * the wizard's entire success condition, so a bare close would silently discard
 * the user's request to turn sync on and snap the toggle back off.
 *
 * Two deliberate constraints:
 * - The event payload is ignored. The phrase belongs to exactly one surface, and
 *   a component that merely steps aside must never become a second holder of it.
 * - Never fires while the surface is showing its OWN phrase, which would drop
 *   the copy the user is mid-way through writing down.
 */
export const useYieldToMigration = ({ open, isShowingOwnRecoveryKey, onYield }: UseYieldToMigrationOptions): void => {
  useEffect(() => {
    if (!open || isShowingOwnRecoveryKey) {
      return
    }
    const yieldToMigration = () => onYield()
    window.addEventListener(migrationRecoveryKeyEvent, yieldToMigration)
    return () => window.removeEventListener(migrationRecoveryKeyEvent, yieldToMigration)
  }, [open, isShowingOwnRecoveryKey, onYield])
}

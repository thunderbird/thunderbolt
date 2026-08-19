/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { dispatchMigrationRecoveryKey } from './use-migration-recovery-key'
import { useYieldToMigration } from './use-yield-to-migration'

const fireMigration = () => act(() => dispatchMigrationRecoveryKey('word '.repeat(24).trim()))

describe('useYieldToMigration', () => {
  afterEach(cleanup)

  it('closes the competing surface when the migration completes', () => {
    const close = mock(() => {})
    renderHook(() => useYieldToMigration({ open: true, isShowingOwnRecoveryKey: false, close }))

    fireMigration()

    expect(close).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the surface is not open', () => {
    const close = mock(() => {})
    renderHook(() => useYieldToMigration({ open: false, isShowingOwnRecoveryKey: false, close }))

    fireMigration()

    expect(close).not.toHaveBeenCalled()
  })

  it('does not close while the surface is showing its own recovery phrase', () => {
    // Closing here would drop the phrase the user is mid-way through writing down.
    const close = mock(() => {})
    renderHook(() => useYieldToMigration({ open: true, isShowingOwnRecoveryKey: true, close }))

    fireMigration()

    expect(close).not.toHaveBeenCalled()
  })

  it('stops listening once unmounted', () => {
    const close = mock(() => {})
    const { unmount } = renderHook(() => useYieldToMigration({ open: true, isShowingOwnRecoveryKey: false, close }))

    unmount()
    fireMigration()

    expect(close).not.toHaveBeenCalled()
  })

  it('starts listening when the surface opens later', () => {
    const close = mock(() => {})
    const { rerender } = renderHook(
      ({ open }: { open: boolean }) => useYieldToMigration({ open, isShowingOwnRecoveryKey: false, close }),
      { initialProps: { open: false } },
    )

    fireMigration()
    expect(close).not.toHaveBeenCalled()

    rerender({ open: true })
    fireMigration()
    expect(close).toHaveBeenCalledTimes(1)
  })
})

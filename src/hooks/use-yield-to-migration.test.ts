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

  it('stands the competing surface down when the migration completes', () => {
    const onYield = mock(() => {})
    renderHook(() => useYieldToMigration({ open: true, isShowingOwnRecoveryKey: false, onYield }))

    fireMigration()

    expect(onYield).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the surface is not open', () => {
    const onYield = mock(() => {})
    renderHook(() => useYieldToMigration({ open: false, isShowingOwnRecoveryKey: false, onYield }))

    fireMigration()

    expect(onYield).not.toHaveBeenCalled()
  })

  it('does not yield while the surface is showing its own recovery phrase', () => {
    // Yielding here would drop the phrase the user is mid-way through writing down.
    const onYield = mock(() => {})
    renderHook(() => useYieldToMigration({ open: true, isShowingOwnRecoveryKey: true, onYield }))

    fireMigration()

    expect(onYield).not.toHaveBeenCalled()
  })

  it('stops listening once unmounted', () => {
    const onYield = mock(() => {})
    const { unmount } = renderHook(() => useYieldToMigration({ open: true, isShowingOwnRecoveryKey: false, onYield }))

    unmount()
    fireMigration()

    expect(onYield).not.toHaveBeenCalled()
  })

  it('starts listening when the surface opens later', () => {
    const onYield = mock(() => {})
    const { rerender } = renderHook(
      ({ open }: { open: boolean }) => useYieldToMigration({ open, isShowingOwnRecoveryKey: false, onYield }),
      { initialProps: { open: false } },
    )

    fireMigration()
    expect(onYield).not.toHaveBeenCalled()

    rerender({ open: true })
    fireMigration()
    expect(onYield).toHaveBeenCalledTimes(1)
  })
})

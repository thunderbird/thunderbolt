/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { dispatchMigrationRecoveryKey, useMigrationRecoveryKey } from './use-migration-recovery-key'

const phrase = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima'

describe('useMigrationRecoveryKey', () => {
  afterEach(cleanup)

  it('surfaces the phrase dispatched by app-init WS6', () => {
    const { result } = renderHook(() => useMigrationRecoveryKey())
    expect(result.current.migrationRecoveryKey).toBeNull()

    act(() => dispatchMigrationRecoveryKey(phrase))
    expect(result.current.migrationRecoveryKey).toBe(phrase)
  })

  it('clears the phrase once acknowledged', () => {
    const { result } = renderHook(() => useMigrationRecoveryKey())
    act(() => dispatchMigrationRecoveryKey(phrase))
    expect(result.current.migrationRecoveryKey).toBe(phrase)

    act(() => result.current.clearMigrationRecoveryKey())
    expect(result.current.migrationRecoveryKey).toBeNull()
  })

  it('ignores an event with no phrase', () => {
    const { result } = renderHook(() => useMigrationRecoveryKey())
    act(() => window.dispatchEvent(new CustomEvent('e2ee_migration_recovery_key', { detail: {} })))
    expect(result.current.migrationRecoveryKey).toBeNull()
  })
})

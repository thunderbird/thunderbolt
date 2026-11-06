/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { settingsTable } from '@/db/tables'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { useWelcomeStore } from '@/components/welcome-dialog'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { eq } from 'drizzle-orm'
import { useWaitlistState } from './use-waitlist-state'

/**
 * GH #1299: a sign-in path that forgets to mark a returning account as
 * onboarded makes the user redo onboarding and then uploads that `false` over
 * the real value on every other device. Each path needs its own assertion —
 * unit-testing the helper alone is what let the magic link go unwired.
 */
describe('useWaitlistState — returning-user onboarding', () => {
  const readOnboarding = async (): Promise<string | null> => {
    const rows = await getDb()
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, 'user_has_completed_onboarding'))
    return (rows[0] as { value: string | null } | undefined)?.value ?? null
  }

  const verifyAs = async (user: { id: string; isNew?: boolean }) => {
    const authClient = createMockAuthClient({
      signInEmailOtp: mock(async () => ({ data: { user }, error: null })),
    })
    const { result } = renderHook(() => useWaitlistState({ authClient }), { wrapper: createTestProvider() })

    act(() => {
      result.current.actions.setEmail('test@example.com')
    })
    await act(async () => {
      await result.current.actions.handleOtpComplete('12345678')
    })
  }

  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    // Seeds `user_has_completed_onboarding = 'false'`, as a fresh device does at
    // boot before it has ever seen the account.
    await reconcileDefaults(getDb())
  })

  afterEach(() => {
    // A returning sign-in arms the welcome dialog, and that store is a module
    // singleton shared across every suite in the worker. Drain it so a
    // randomized run cannot leak `pending: true` into `welcome-dialog.test.ts`.
    useWelcomeStore.setState({ pending: false })
  })

  it('marks onboarding complete for an account that already existed', async () => {
    await verifyAs({ id: 'u1', isNew: false })

    expect(await readOnboarding()).toBe('true')
  })

  it('leaves onboarding pending for a brand-new account', async () => {
    await verifyAs({ id: 'u1', isNew: true })

    expect(await readOnboarding()).toBe('false')
  })
})

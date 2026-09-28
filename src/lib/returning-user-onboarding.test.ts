/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { settingsTable } from '@/db/tables'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, test } from 'bun:test'
import { isNewAuthUser, markOnboardedForReturningUser } from './returning-user-onboarding'

describe('isNewAuthUser', () => {
  test('returns true when isNew is true', () => {
    expect(isNewAuthUser({ id: '1', isNew: true })).toBe(true)
  })

  test('returns false when isNew is false', () => {
    expect(isNewAuthUser({ id: '1', isNew: false })).toBe(false)
  })

  test('returns false when isNew is missing', () => {
    expect(isNewAuthUser({ id: '1' })).toBe(false)
  })

  test('returns false for null', () => {
    expect(isNewAuthUser(null)).toBe(false)
  })

  test('returns false for undefined', () => {
    expect(isNewAuthUser(undefined)).toBe(false)
  })

  test('returns false for non-boolean truthy isNew', () => {
    expect(isNewAuthUser({ isNew: 1 })).toBe(false)
    expect(isNewAuthUser({ isNew: 'yes' })).toBe(false)
  })
})

describe('markOnboardedForReturningUser', () => {
  const readOnboarding = async (): Promise<string | null> => {
    const rows = await getDb()
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, 'user_has_completed_onboarding'))
    return (rows[0] as { value: string | null } | undefined)?.value ?? null
  }

  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    // Seeds `user_has_completed_onboarding = 'false'`, exactly as a fresh
    // device does at boot before it has ever seen the account.
    await reconcileDefaults(getDb())
  })

  it('marks onboarding complete when the account already existed', async () => {
    await markOnboardedForReturningUser({ id: 'u1', isNew: false }, getDb)

    expect(await readOnboarding()).toBe('true')
  })

  it('leaves onboarding pending for a brand-new account', async () => {
    await markOnboardedForReturningUser({ id: 'u1', isNew: true }, getDb)

    expect(await readOnboarding()).toBe('false')
  })

  it('treats a response without the flag as returning', async () => {
    // `isNewAuthUser` is strict about the flag, and the fallback direction is
    // deliberate: a sign-in response that does not say "brand new" describes an
    // account that already existed.
    await markOnboardedForReturningUser({ id: 'u1' }, getDb)

    expect(await readOnboarding()).toBe('true')
  })

  it('does not throw when the write fails', async () => {
    // The caller turns any throw into a "verification failed" screen even
    // though the OTP is already spent and the user is signed in.
    const brokenDb = () => {
      throw new Error('database is gone')
    }

    await expect(markOnboardedForReturningUser({ id: 'u1', isNew: false }, brokenDb)).resolves.toBeUndefined()
  })
})

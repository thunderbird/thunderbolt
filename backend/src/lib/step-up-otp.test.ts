/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { verification } from '@/db/auth-schema'
import { createTestDb } from '@/test-utils/db'
import { consumeStepUpOtp, mintStepUpOtp, stepUpIdentifier, stepUpOtpLength, verifyStepUpOtp } from './step-up-otp'

describe('step-up OTP (THU-875)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  const email = 'step-up@example.com'

  const readRow = async () => {
    const [row] = await db
      .select()
      .from(verification)
      .where(eq(verification.identifier, stepUpIdentifier(email)))
    return row
  }

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
    }
  })

  describe('stepUpIdentifier', () => {
    /**
     * The security property of the whole module. Better-auth composes every
     * identifier it can read or write as `toOTPIdentifier(type, email)` =
     * `${type}-otp-${email}` over a CLOSED enum, so staying outside that
     * grammar is what keeps the unauthenticated
     * `/email-otp/check-verification-otp` away from this row.
     */
    it('is unreachable from better-auth’s OTP-type grammar', () => {
      const betterAuthTypes = ['email-verification', 'sign-in', 'forget-password', 'change-email'] as const
      for (const type of betterAuthTypes) {
        expect(stepUpIdentifier(email)).not.toBe(`${type}-otp-${email}`)
      }
    })

    it('normalises case, so a differently-cased session email finds its own row', () => {
      expect(stepUpIdentifier('Step-Up@Example.COM')).toBe(stepUpIdentifier(email))
    })
  })

  describe('mintStepUpOtp', () => {
    it('stores exactly one row as `<code>:0`', async () => {
      const code = await mintStepUpOtp(db, email)
      expect(code).toMatch(new RegExp(`^\\d{${stepUpOtpLength}}$`))

      const rows = await db
        .select()
        .from(verification)
        .where(eq(verification.identifier, stepUpIdentifier(email)))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.value).toBe(`${code}:0`)
      expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now())
    })

    it('rotates per request — a re-mint replaces the code and resets the budget', async () => {
      const first = await mintStepUpOtp(db, email)
      await verifyStepUpOtp(db, email, 'wrong-1')
      await verifyStepUpOtp(db, email, 'wrong-2')

      const second = await mintStepUpOtp(db, email)
      expect(second).not.toBe(first)
      expect((await readRow())!.value).toBe(`${second}:0`)
      expect(await verifyStepUpOtp(db, email, first)).toBe('invalid')
      expect(await verifyStepUpOtp(db, email, second)).toBe('valid')
    })

    it('draws uniformly over all ten digits', async () => {
      const seen = new Set<string>()
      for (let i = 0; i < 40; i++) {
        for (const digit of await mintStepUpOtp(db, `${i}-${email}`)) {
          seen.add(digit)
        }
      }
      expect(seen.size).toBe(10)
    })
  })

  describe('verifyStepUpOtp', () => {
    it('accepts the right code without consuming it', async () => {
      const code = await mintStepUpOtp(db, email)
      expect(await verifyStepUpOtp(db, email, code)).toBe('valid')
      expect(await verifyStepUpOtp(db, email, code)).toBe('valid')
    })

    it('reports `invalid` when no code was ever minted', async () => {
      expect(await verifyStepUpOtp(db, email, '12345678')).toBe('invalid')
    })

    it('charges a wrong guess against the budget and kills the row on the fourth', async () => {
      const code = await mintStepUpOtp(db, email)
      expect(await verifyStepUpOtp(db, email, '00000001')).toBe('invalid')
      expect((await readRow())!.value).toBe(`${code}:1`)
      expect(await verifyStepUpOtp(db, email, '00000002')).toBe('invalid')
      expect(await verifyStepUpOtp(db, email, '00000003')).toBe('invalid')

      // Budget spent: even the CORRECT code is refused, and the row is gone.
      expect(await verifyStepUpOtp(db, email, code)).toBe('too-many-attempts')
      expect(await readRow()).toBeUndefined()
    })

    it('reports `expired` and clears the row once the window closes', async () => {
      const code = await mintStepUpOtp(db, email)
      await db
        .update(verification)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(verification.identifier, stepUpIdentifier(email)))

      expect(await verifyStepUpOtp(db, email, code)).toBe('expired')
      expect(await readRow()).toBeUndefined()
    })

    it('matches a stored value carrying no attempt suffix', async () => {
      await mintStepUpOtp(db, email)
      await db
        .update(verification)
        .set({ value: '11112222' })
        .where(eq(verification.identifier, stepUpIdentifier(email)))

      expect(await verifyStepUpOtp(db, email, '11112222')).toBe('valid')
    })
  })

  describe('consumeStepUpOtp', () => {
    it('deletes the row so the code cannot be replayed', async () => {
      const code = await mintStepUpOtp(db, email)
      await consumeStepUpOtp(db, email)
      expect(await readRow()).toBeUndefined()
      expect(await verifyStepUpOtp(db, email, code)).toBe('invalid')
    })

    it('leaves another account’s code alone', async () => {
      const other = 'other@example.com'
      const otherCode = await mintStepUpOtp(db, other)
      await mintStepUpOtp(db, email)

      await consumeStepUpOtp(db, email)
      expect(await verifyStepUpOtp(db, other, otherCode)).toBe('valid')
    })
  })
})

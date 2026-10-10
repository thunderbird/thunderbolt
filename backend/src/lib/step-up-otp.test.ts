/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { verification } from '@/db/auth-schema'
import { createTestDb } from '@/test-utils/db'
import {
  consumeStepUpOtp,
  mintStepUpOtp,
  requestStepUpOtp,
  stepUpActions,
  stepUpIdentifier,
  stepUpOtpLength,
  verifyStepUpOtp,
  type StepUpAction,
} from './step-up-otp'

/** The action under test everywhere the specific one does not matter. */
const action: StepUpAction = 'recovery-phrase-change'

/**
 * Per-RUN id, not just per-test. `database.transaction` COMMITs on this
 * harness's single shared connection, so rows written through one outlive
 * `createTestDb`'s `ROLLBACK` — and CI re-runs each file in ONE process
 * (`--rerun-each 5`), where run N would otherwise read run N-1's cooldown row
 * and fail. Same counter pattern as `canary.test.ts`.
 */
const counterKey = Symbol.for('step-up-otp-test-runId')
;(globalThis as Record<symbol, number>)[counterKey] ??= 0

describe('step-up OTP (THU-875)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>
  let rid: number
  let email: string

  const readRow = async () => {
    const [row] = await db
      .select()
      .from(verification)
      .where(eq(verification.identifier, stepUpIdentifier(action, email)))
    return row
  }

  beforeEach(async () => {
    rid = ++(globalThis as Record<symbol, number>)[counterKey]
    email = `step-up-${rid}@example.com`
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
    }
  })

  // These assert a pure string function and touch no rows, so they use a
  // FIXED address rather than the per-run `email`: the case test needs a known
  // mixed-case spelling of the very same address, which a generated one cannot
  // supply.
  describe('stepUpIdentifier', () => {
    const fixedEmail = 'step-up@example.com'
    const betterAuthTypes = ['email-verification', 'sign-in', 'forget-password', 'change-email'] as const

    /** `e2e/e2ee/db.ts` reads rows by this exact string; nothing else guards that coupling. */
    it('spells each action’s identifier exactly', () => {
      expect(stepUpIdentifier('recovery-phrase-change', fixedEmail)).toBe(
        `recovery-phrase-change-step-up-otp-${fixedEmail}`,
      )
      expect(stepUpIdentifier('account-deletion', fixedEmail)).toBe(`account-deletion-step-up-otp-${fixedEmail}`)
    })

    /**
     * The security property of the whole module. Better-auth composes every
     * identifier it can read or write as `toOTPIdentifier(type, email)` =
     * `${type}-otp-${email}` over a CLOSED enum, so staying outside that
     * grammar is what keeps the unauthenticated
     * `/email-otp/check-verification-otp` away from this row.
     */
    it('is unreachable from better-auth’s OTP-type grammar, for every action', () => {
      for (const candidate of stepUpActions) {
        for (const type of betterAuthTypes) {
          expect(stepUpIdentifier(candidate, fixedEmail)).not.toBe(`${type}-otp-${fixedEmail}`)
        }
      }
    })

    /** Why the above holds, asserted directly so it also covers an action added later. */
    it('keeps every action out of better-auth’s type enum', () => {
      for (const candidate of stepUpActions) {
        expect(betterAuthTypes).not.toContain(`${candidate}-step-up`)
      }
    })

    it('gives each action its own namespace', () => {
      const identifiers = stepUpActions.map((candidate) => stepUpIdentifier(candidate, fixedEmail))
      expect(new Set(identifiers).size).toBe(stepUpActions.length)
    })

    it('normalises case, so a differently-cased session email finds its own row', () => {
      expect(stepUpIdentifier(action, 'Step-Up@Example.COM')).toBe(stepUpIdentifier(action, fixedEmail))
    })
  })

  describe('requestStepUpOtp', () => {
    // A fresh address per test AND per run — see `counterKey` above for why the
    // run half matters. `database.transaction` issues a real COMMIT on this
    // harness's single shared connection, which ends the outer transaction
    // `createTestDb` opened — so its `ROLLBACK` does not undo rows written
    // through one, and an account's rows outlive the test that made them. The
    // mint-only tests below never noticed because every mint deletes the
    // identifier's rows first; a cooldown check reads them.
    const freshEmail = (label: string) => `step-up-${rid}-${label}@example.com`

    it('refuses a second request inside the cooldown, leaving the first code alive', async () => {
      const cooldownEmail = freshEmail('cooldown')
      const first = await requestStepUpOtp(db, action, cooldownEmail)
      expect(first.status).toBe('sent')

      const second = await requestStepUpOtp(db, action, cooldownEmail)
      expect(second.status).toBe('cooling-down')

      // The old Map-based gate recorded the cooldown only after the email went
      // out, so a second request got through and its mint DELETED this row —
      // the user held a code that could never verify.
      expect(first.status === 'sent' && (await verifyStepUpOtp(db, action, cooldownEmail, first.code))).toBe('valid')
    })

    // NOT tested here: that the advisory lock serializes genuinely concurrent
    // requests. This harness runs every test inside one `BEGIN` on a single
    // shared connection (`test-utils/db.ts`), so `database.transaction` is a
    // savepoint, `Promise.all` interleaves statements on one session rather
    // than running them in parallel, and a session re-acquires its own
    // advisory lock freely. Such a test would pass with the lock removed. The
    // same limit applies to `withUserDeviceRegistrationLock` and to
    // `verifyStepUpOtp`'s `FOR UPDATE`, neither of which is covered either.

    it('scopes the cooldown to one account', async () => {
      expect((await requestStepUpOtp(db, action, freshEmail('scope-a'))).status).toBe('sent')
      expect((await requestStepUpOtp(db, action, freshEmail('scope-b'))).status).toBe('sent')
    })
  })

  describe('mintStepUpOtp', () => {
    it('stores exactly one row as `<code>:0`', async () => {
      const code = await mintStepUpOtp(db, action, email)
      expect(code).toMatch(new RegExp(`^\\d{${stepUpOtpLength}}$`))

      const rows = await db
        .select()
        .from(verification)
        .where(eq(verification.identifier, stepUpIdentifier(action, email)))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.value).toBe(`${code}:0`)
      expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now())
    })

    it('rotates per request — a re-mint replaces the code and resets the budget', async () => {
      const first = await mintStepUpOtp(db, action, email)
      await verifyStepUpOtp(db, action, email, 'wrong-1')
      await verifyStepUpOtp(db, action, email, 'wrong-2')

      const second = await mintStepUpOtp(db, action, email)
      expect(second).not.toBe(first)
      expect((await readRow())!.value).toBe(`${second}:0`)
      expect(await verifyStepUpOtp(db, action, email, first)).toBe('invalid')
      expect(await verifyStepUpOtp(db, action, email, second)).toBe('valid')
    })

    it('draws uniformly over all ten digits', async () => {
      const seen = new Set<string>()
      for (let i = 0; i < 40; i++) {
        for (const digit of await mintStepUpOtp(db, action, `${i}-${email}`)) {
          seen.add(digit)
        }
      }
      expect(seen.size).toBe(10)
    })
  })

  describe('verifyStepUpOtp', () => {
    it('accepts the right code without consuming it', async () => {
      const code = await mintStepUpOtp(db, action, email)
      expect(await verifyStepUpOtp(db, action, email, code)).toBe('valid')
      expect(await verifyStepUpOtp(db, action, email, code)).toBe('valid')
    })

    it('reports `invalid` when no code was ever minted', async () => {
      expect(await verifyStepUpOtp(db, action, email, '12345678')).toBe('invalid')
    })

    it('charges a wrong guess against the budget and kills the row on the fourth', async () => {
      const code = await mintStepUpOtp(db, action, email)
      expect(await verifyStepUpOtp(db, action, email, '00000001')).toBe('invalid')
      expect((await readRow())!.value).toBe(`${code}:1`)
      expect(await verifyStepUpOtp(db, action, email, '00000002')).toBe('invalid')
      expect(await verifyStepUpOtp(db, action, email, '00000003')).toBe('invalid')

      // Budget spent: even the CORRECT code is refused, and the row is gone.
      expect(await verifyStepUpOtp(db, action, email, code)).toBe('too-many-attempts')
      expect(await readRow()).toBeUndefined()
    })

    it('charges every guess in a concurrent burst, not just one', async () => {
      // The budget is the whole defence, and the attacker this gate stops
      // already holds a session — so it can fire guesses in parallel. Read and
      // charge must serialize; otherwise all three read `attempts: 0`, all three
      // write `1`, and three guesses cost one attempt.
      const code = await mintStepUpOtp(db, action, email)
      const verdicts = await Promise.all([
        verifyStepUpOtp(db, action, email, '00000001'),
        verifyStepUpOtp(db, action, email, '00000002'),
        verifyStepUpOtp(db, action, email, '00000003'),
      ])

      expect(verdicts).toEqual(['invalid', 'invalid', 'invalid'])
      expect(await verifyStepUpOtp(db, action, email, code)).toBe('too-many-attempts')
    })

    it('reports `expired` and clears the row once the window closes', async () => {
      const code = await mintStepUpOtp(db, action, email)
      await db
        .update(verification)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(verification.identifier, stepUpIdentifier(action, email)))

      expect(await verifyStepUpOtp(db, action, email, code)).toBe('expired')
      expect(await readRow()).toBeUndefined()
    })

    it('matches a stored value carrying no attempt suffix', async () => {
      await mintStepUpOtp(db, action, email)
      await db
        .update(verification)
        .set({ value: '11112222' })
        .where(eq(verification.identifier, stepUpIdentifier(action, email)))

      expect(await verifyStepUpOtp(db, action, email, '11112222')).toBe('valid')
    })
  })

  describe('consumeStepUpOtp', () => {
    it('deletes the row so the code cannot be replayed', async () => {
      const code = await mintStepUpOtp(db, action, email)
      await consumeStepUpOtp(db, action, email)
      expect(await readRow()).toBeUndefined()
      expect(await verifyStepUpOtp(db, action, email, code)).toBe('invalid')
    })

    it('leaves another account’s code alone', async () => {
      const other = 'other@example.com'
      const otherCode = await mintStepUpOtp(db, action, other)
      await mintStepUpOtp(db, action, email)

      await consumeStepUpOtp(db, action, email)
      expect(await verifyStepUpOtp(db, action, other, otherCode)).toBe('valid')
    })
  })

  /** One account can hold a live code per action, and the two must not touch. */
  describe('action isolation', () => {
    const otherAction: StepUpAction = 'account-deletion'

    const readValue = async (forAction: StepUpAction) => {
      const [row] = await db
        .select()
        .from(verification)
        .where(eq(verification.identifier, stepUpIdentifier(forAction, email)))
      return row?.value
    }

    it('refuses a code minted for another action', async () => {
      const code = await mintStepUpOtp(db, action, email)
      expect(await verifyStepUpOtp(db, otherAction, email, code)).toBe('invalid')
    })

    it('charges a wrong guess to its own action only', async () => {
      const code = await mintStepUpOtp(db, action, email)
      await mintStepUpOtp(db, otherAction, email)

      expect(await verifyStepUpOtp(db, action, email, '00000001')).toBe('invalid')

      expect(await readValue(action)).toBe(`${code}:1`)
      expect(await readValue(otherAction)).toMatch(/:0$/)
    })

    it('scopes the cooldown per action', async () => {
      expect((await requestStepUpOtp(db, action, email)).status).toBe('sent')
      expect((await requestStepUpOtp(db, otherAction, email)).status).toBe('sent')
    })

    it('consumes only its own action’s code', async () => {
      await mintStepUpOtp(db, action, email)
      const otherCode = await mintStepUpOtp(db, otherAction, email)

      await consumeStepUpOtp(db, action, email)
      expect(await verifyStepUpOtp(db, otherAction, email, otherCode)).toBe('valid')
    })
  })
})

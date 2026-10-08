/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import type { SecurityNotifications } from '@/lib/security-notifications'
import { consumeStepUpOtp, requestStepUpOtp, verifyStepUpOtp, type StepUpAction } from '@/lib/step-up-otp'
import type { AppLocale } from '@shared/i18n/locales'

/**
 * Route-level step-up gate: the HTTP policy every gated action shares, so a new
 * one is a route plus a copy entry rather than a re-implementation.
 *
 * Each helper returns `null` to mean "carry on", or a response to return
 * verbatim. The caller keeps its own preconditions (device binding, trust,
 * ownership) — only the shared part lives here.
 */

export type StepUpRefusal = {
  status: 403
  body: { error: string; code: 'step_up_required' | 'step_up_invalid' }
}

export type StepUpCooldown = { status: 429; body: { error: string } }

/**
 * Developer-facing text for a missing code; clients branch on `code`, not this.
 * Exhaustive, so a new action must say what its code is for.
 */
export const stepUpRequiredMessage: Record<StepUpAction, string> = {
  'recovery-phrase-change': 'Step-up verification required to change the recovery phrase',
  'account-deletion': 'Step-up verification required to delete your account',
}

/** Mint a code and email it. Returns the 429 to return when the cooldown is still running. */
export const sendStepUpCode = async (
  database: typeof DbType,
  notifications: SecurityNotifications,
  action: StepUpAction,
  params: { email: string; deviceName: string; locale: AppLocale },
): Promise<StepUpCooldown | null> => {
  // The cooldown is enforced inside the mint's transaction, against the
  // outstanding row's own `createdAt` — shared across replicas and atomic.
  const stepUp = await requestStepUpOtp(database, action, params.email)
  if (stepUp.status === 'cooling-down') {
    return { status: 429, body: { error: 'A code was just sent — wait a moment before requesting another' } }
  }
  await notifications.sendStepUpCode({ action, code: stepUp.code, ...params })
  return null
}

/**
 * Require a valid code before the gated action runs.
 *
 * Every rejection collapses to one response on purpose: distinguishing
 * invalid from expired from exhausted would tell an attacker holding only the
 * session whether a code is outstanding. A storage failure throws instead, so
 * an outage stays a 500 rather than telling a user their code was wrong and
 * walking them into spending their remaining attempts on it.
 *
 * `email` must come from the session, never from client input.
 */
export const requireStepUpCode = async (
  database: typeof DbType,
  action: StepUpAction,
  email: string,
  otp: string | undefined,
): Promise<StepUpRefusal | null> => {
  if (!otp) {
    return { status: 403, body: { error: stepUpRequiredMessage[action], code: 'step_up_required' } }
  }
  const verdict = await verifyStepUpOtp(database, action, email, otp)
  if (verdict !== 'valid') {
    return { status: 403, body: { error: 'Invalid or expired verification code', code: 'step_up_invalid' } }
  }
  return null
}

/**
 * Burn the code once the gated action has committed, so an action that failed
 * midway stays retryable with the same code. Never throws: a failed delete
 * leaves the code valid until its own expiry, for the inbox holder only, which
 * must not fail an operation that already committed.
 *
 * `verification` has no `user_id` FK, so nothing else collects the row.
 */
export const burnStepUpCode = (database: typeof DbType, action: StepUpAction, email: string): void => {
  void consumeStepUpOtp(database, action, email).catch((err) =>
    console.error('[step-up] failed to consume verification code:', err),
  )
}

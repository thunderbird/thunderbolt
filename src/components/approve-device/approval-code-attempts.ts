/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Local cap on approval-code attempts. A user who taps without looking picks the right code one
 * time in six, so this device allows three unsuccessful attempts per day, across all pending
 * devices, before only the fingerprint remains. It lives here, not on the server, so neither a
 * malicious server nor a stolen session can reset it. An attempt counts before its challenge
 * leaves this device, and is forgiven only when it ends in approval. A refused challenge, a closed
 * dialog, a timeout or a killed app all stay counted.
 */

import { z } from 'zod'

/** localStorage key of this device's recent code attempts; tests clear it between runs. */
export const approvalCodeAttemptsKey = 'thunderbolt.device-approval-code-failures'

/** Web Lock that every tab holds while it changes the record; exported so tests can hold it too. */
export const approvalCodeAttemptsLockName = 'thunderbolt-device-approval-code-attempts'

const approvalCodeFailureLimit = 3
export const approvalCodeFailureWindowMs = 24 * 60 * 60 * 1000

const attemptsSchema = z.array(z.number())

/** An unreadable record counts as no attempts: only this device writes it, and only through this module. */
const parseAttempts = (raw: string | null): number[] => {
  try {
    return attemptsSchema.catch([]).parse(JSON.parse(raw ?? '[]'))
  } catch {
    return []
  }
}

const readRecentAttempts = (now: number): number[] =>
  parseAttempts(localStorage.getItem(approvalCodeAttemptsKey)).filter(
    (startedAt) => now - startedAt < approvalCodeFailureWindowMs,
  )

const writeAttempts = (attempts: number[]) => localStorage.setItem(approvalCodeAttemptsKey, JSON.stringify(attempts))

/**
 * Read and write the record under one origin-wide lock. localStorage gives no atomic
 * read-modify-write across tabs, so without it two tabs could both read two attempts and both take
 * the third. Encrypted sync already requires Web Locks, so a trusted device always has them.
 */
const withAttemptsLock = <Result>(update: () => Result): Promise<Result> =>
  navigator.locks.request(approvalCodeAttemptsLockName, update)

/** Whether this device may still offer the code path. */
export const canUseApprovalCode = (now = Date.now()): boolean =>
  readRecentAttempts(now).length < approvalCodeFailureLimit

/**
 * Reserve an attempt, counted as unsuccessful up front, or null when the cap is reached. Check and
 * write happen under the lock, so several open dialogs (tabs) cannot all pass the check first and
 * reserve later.
 */
export const startApprovalCodeAttempt = (now = Date.now()): Promise<number | null> =>
  withAttemptsLock(() => {
    const recent = readRecentAttempts(now)
    if (recent.length >= approvalCodeFailureLimit) {
      return null
    }
    writeAttempts([...recent, now])
    return now
  })

/** Remove an attempt that ended in approval. */
export const forgiveApprovalCodeAttempt = (startedAt: number): Promise<void> =>
  withAttemptsLock(() => {
    const attempts = parseAttempts(localStorage.getItem(approvalCodeAttemptsKey))
    const index = attempts.indexOf(startedAt)
    if (index >= 0) {
      writeAttempts(attempts.toSpliced(index, 1))
    }
  })

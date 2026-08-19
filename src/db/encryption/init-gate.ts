/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A one-shot signal for "the boot-time v1→v2 migration/follow check has
 * finished".
 *
 * It exists for one ordering problem: `needsSyncSetupWizard()` answers `true`
 * for a returning v1 device for the whole duration of its seamless migration
 * (the AK is only stored at the last step), and the sync toggle reacts to that
 * `true` by switching sync off. Without this gate the toggle — a single
 * IndexedDB read — reliably wins the race against a migration that makes a
 * network round trip, and turns sync off for exactly the user the seamless
 * migration exists to serve.
 *
 * Resolves immediately when init never started (tests, standalone surfaces), so
 * a caller can always await it.
 */

let pending: { promise: Promise<void>; settle: () => void } | null = null

/** Arm the gate. Called by app init BEFORE it kicks off the migration check. */
export const beginEncryptionInit = (): void => {
  if (pending) {
    return
  }
  let settle!: () => void
  const promise = new Promise<void>((resolve) => {
    settle = resolve
  })
  pending = { promise, settle }
}

/**
 * Release the gate — always call this, including when the check failed.
 * Clears `pending` as well as settling it: app init runs again on `retry()` and
 * `clearDatabase()`, and a left-behind settled gate would make the next
 * `beginEncryptionInit` a no-op and the next `waitForEncryptionInit` return
 * instantly, silently reopening the race this module exists to close.
 */
export const endEncryptionInit = (): void => {
  pending?.settle()
  pending = null
}

/** Bounds the wait so a hung migration can't wedge callers indefinitely. */
const initGateTimeoutMs = 15_000

/**
 * Wait for the boot-time check to settle. Resolves `true` when it actually
 * settled (including when init never ran), `false` when the wait timed out.
 *
 * Callers must not treat a timeout as "the migration concluded": the AK is
 * stored last, so a migration still in flight looks identical to a device that
 * was never set up. Acting on that verdict is how you switch sync off for the
 * exact user the seamless migration exists to serve.
 */
export const waitForEncryptionInit = async (): Promise<boolean> => {
  if (!pending) {
    return true
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending.promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), initGateTimeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Test-only: forget any armed gate so each test starts from "init never ran". */
export const resetEncryptionInitGate = (): void => {
  pending = null
}

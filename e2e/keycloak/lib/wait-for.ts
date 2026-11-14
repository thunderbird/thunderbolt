/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Poll `load` until it returns something other than null or undefined. The extension delivers
 * after Keycloak's own transaction commits, so every Thunderbolt-side assertion waits for it.
 */
export const waitFor = async <T>(
  what: string,
  load: () => Promise<T | null | undefined>,
  { timeoutMs = 30_000, intervalMs = 250 } = {},
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await load()
    if (value !== null && value !== undefined) {
      return value
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`)
    }
    await Bun.sleep(intervalMs)
  }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { spyOn } from 'bun:test'

type ConsoleSpy = ReturnType<typeof spyOn>

export type ConsoleSpies = {
  log: ConsoleSpy
  info: ConsoleSpy
  error: ConsoleSpy
  warn: ConsoleSpy
  restore: () => void
}

/**
 * Creates spies for all console methods to reduce test noise.
 * Call the returned `restore()` function in `afterAll()` to clean up.
 *
 * @example
 * ```ts
 * let consoleSpies: ConsoleSpies
 *
 * beforeAll(() => {
 *   consoleSpies = setupConsoleSpy()
 * })
 *
 * afterAll(() => {
 *   consoleSpies.restore()
 * })
 * ```
 */
export const setupConsoleSpy = (): ConsoleSpies => {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const info = spyOn(console, 'info').mockImplementation(() => {})
  const error = spyOn(console, 'error').mockImplementation(() => {})
  const warn = spyOn(console, 'warn').mockImplementation(() => {})

  const restore = () => {
    log?.mockRestore()
    info?.mockRestore()
    error?.mockRestore()
    warn?.mockRestore()
  }

  return { log, info, error, warn, restore }
}

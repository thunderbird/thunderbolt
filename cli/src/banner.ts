/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Standalone REPL banner. Uses raw ANSI so it stays decoupled from the UI
 * theme, and skips color when NO_COLOR is set or stdout isn't a TTY.
 */

import { cliVersion } from './cli.ts'

/** Whether to emit ANSI color: only on an interactive TTY without NO_COLOR. */
const useColor = (): boolean => !process.env.NO_COLOR && process.stdout.isTTY === true

/**
 * Builds the two-line REPL header (title + version, then a one-line hint) as a
 * string. Color is applied only on an interactive TTY. Returned rather than
 * written so the TUI can wrap it in a component instead of touching stdout,
 * which would corrupt the differential renderer.
 */
export const bannerText = (): string => {
  const color = useColor()
  const bold = color ? '\x1b[1m' : ''
  const yellow = color ? '\x1b[33m' : ''
  const dim = color ? '\x1b[2m' : ''
  const reset = color ? '\x1b[0m' : ''

  return (
    `${bold}${yellow}⚡ thunderbolt${reset} ${dim}v${cliVersion}${reset}\n` +
    `${dim}type a task, or 'exit' to quit${reset}`
  )
}

/**
 * Prints the REPL header to stdout for the plain (non-TUI) interactive loop.
 * No-op-safe in non-TTY environments (the text still prints, just without
 * color).
 */
export const printBanner = (): void => {
  process.stdout.write(`${bannerText()}\n\n`)
}

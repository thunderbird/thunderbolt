/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Standalone REPL banner. Uses raw ANSI so it stays decoupled from the UI
 * theme, and skips color when NO_COLOR is set or stdout isn't a TTY.
 */

import { VERSION } from './cli.ts'

/** Whether to emit ANSI color: only on an interactive TTY without NO_COLOR. */
const useColor = (): boolean => !process.env.NO_COLOR && process.stdout.isTTY === true

/**
 * Prints a small colored header for the interactive REPL: the thunderbolt
 * title, version, and a one-line hint. No-op-safe in non-TTY environments
 * (the text still prints, just without color).
 */
export const printBanner = (): void => {
  const color = useColor()
  const bold = color ? '\x1b[1m' : ''
  const yellow = color ? '\x1b[33m' : ''
  const dim = color ? '\x1b[2m' : ''
  const reset = color ? '\x1b[0m' : ''

  process.stdout.write(
    `${bold}${yellow}⚡ thunderbolt${reset} ${dim}v${VERSION}${reset}\n` +
      `${dim}type a task, or 'exit' to quit${reset}\n\n`,
  )
}

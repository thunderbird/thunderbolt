/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Standalone REPL banner shared by plain and TUI modes.
 */

import { cliVersion } from './cli.ts'
import { bold, brandGradient, dim, spark } from './ui/theme.ts'

export const bannerHint = 'type a task, or / for commands'

/**
 * Builds the two-line REPL header (title + version, then a one-line hint) as a
 * string. Color is applied only on an interactive TTY. Returned rather than
 * written so the TUI can wrap it in a component instead of touching stdout,
 * which would corrupt the differential renderer.
 */
export const bannerText = (width: number = process.stdout.columns ?? 80): string => {
  const hairlineLength = Math.min(28, Math.max(8, Math.floor(width / 5)))
  return `${bold(spark())} ${bold(brandGradient('thunderbolt'))} ${dim(`v${cliVersion}`)}\n${brandGradient(
    '─'.repeat(hairlineLength),
  )}\n${dim(bannerHint)}`
}

/**
 * Prints the REPL header to stdout for the plain (non-TUI) interactive loop.
 * No-op-safe in non-TTY environments (the text still prints, just without
 * color).
 */
export const printBanner = (): void => {
  process.stdout.write(`${bannerText()}\n\n`)
}

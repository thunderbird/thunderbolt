/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Minimal, dependency-free ANSI styling for the thunderbolt CLI's terminal
 * renderer. Color is suppressed when `NO_COLOR` holds a non-empty value or when
 * stdout is not a TTY (piped/redirected output stays plain). The decision is
 * resolved once at module load — the environment and TTY status don't change
 * mid-run.
 */

const colorEnabled = !process.env.NO_COLOR && Boolean(process.stdout.isTTY)

/**
 * Builds a styling helper that wraps text in an ANSI SGR sequence, returning
 * the text unchanged when color is disabled.
 *
 * @param open - the opening SGR escape (e.g. `\x1b[36m` for cyan)
 * @returns a helper that styles a string and resets afterwards
 */
const style =
  (open: string) =>
  (text: string): string =>
    colorEnabled ? `${open}${text}\x1b[0m` : text

/** Dims text — used for subdued output like the agent's thinking stream. */
export const dim = style('\x1b[2m')
/** Colors text cyan — used for tool names and headers. */
export const cyan = style('\x1b[36m')
/** Colors text green — used for success markers. */
export const green = style('\x1b[32m')
/** Colors text red — used for failure markers. */
export const red = style('\x1b[31m')
/** Colors text gray — used for secondary detail and result previews. */
export const gray = style('\x1b[90m')

/** Glyphs marking tool activity in the streamed output. */
export const symbols = {
  /** Precedes a tool invocation. */
  tool: '⏺',
  /** Marks a successful tool result. */
  ok: '✓',
  /** Marks a failed tool result. */
  fail: '✗',
} as const

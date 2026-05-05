/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type InsecureDefault, detectInsecureDefaults, renderTerminalBanner } from '@shared/insecure-defaults'

/**
 * Returns the subset of well-known default credentials currently in use by
 * this backend, based on its env vars. Empty when DANGEROUSLY_ALLOW_DEFAULT_CREDS
 * is set.
 */
export const detectInsecureDefaultsForBackend = (
  env: Record<string, string | undefined> = process.env,
): InsecureDefault[] => {
  return detectInsecureDefaults((entry) => env[entry.envKey], env)
}

/**
 * Render the multi-line ANSI banner. Color is auto-disabled when stderr
 * isn't a TTY (CI logs, files, redirected pipes) so the box drawing stays
 * readable but doesn't pollute log aggregators with escape sequences.
 */
export const renderInsecureDefaultsBanner = (matches: InsecureDefault[]): string => {
  const useColor = Boolean(process.stderr.isTTY)
  return renderTerminalBanner(matches, useColor)
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Shared filesystem locations for persistent thunderbolt CLI state. */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Root for all thunderbolt CLI state. `THUNDERBOLT_HOME` overrides the default
 *  `~/.thunderbolt`, enabling isolated identities for testing/multi-account. */
export const thunderboltHomeDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string => env.THUNDERBOLT_HOME ?? join(home, '.thunderbolt')

/** Resolves persisted CLI config path. */
export const configPath = (env: Readonly<Record<string, string | undefined>> = process.env): string =>
  join(thunderboltHomeDir(env), 'config.json')

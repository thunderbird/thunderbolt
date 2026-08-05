/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Typed persistence for user-editable CLI defaults. */

import { dirname } from 'node:path'
import { isProvider } from '../agent/types.ts'
import type { ModelProvider } from '../agent/types.ts'
import { isRecord } from '../lib/json.ts'
import { readFileOrNull, writeSecureFile } from '../lib/secure-fs.ts'
import { configPath } from '../paths.ts'

/** Minimal persisted CLI profile. */
export type CliConfig = {
  readonly provider: ModelProvider
  readonly model: string
  readonly apiKey?: string
  readonly baseUrl?: string
}

/** Validates unknown JSON and returns a minimal canonical config. */
const parseConfig = (value: unknown): CliConfig | null => {
  if (!isRecord(value) || !isProvider(value.provider) || typeof value.model !== 'string') return null
  if (value.apiKey !== undefined && typeof value.apiKey !== 'string') return null
  if (value.baseUrl !== undefined && typeof value.baseUrl !== 'string') return null

  return {
    provider: value.provider,
    model: value.model,
    apiKey: value.apiKey,
    baseUrl: value.baseUrl,
  }
}

/** Parses JSON, mapping malformed user-edited text to `undefined`. */
const parseJsonOrUndefined = (contents: string): unknown => {
  try {
    return JSON.parse(contents) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

/** Loads config. A missing file is silently absent; an existing file that fails
 *  to parse or validate is also treated as absent, but reported on stderr so a
 *  saved provider/model/key never vanishes without explanation. */
export const loadConfig = async (path: string = configPath()): Promise<CliConfig | null> => {
  const contents = await readFileOrNull(path)
  if (contents === null) return null

  const parsed = parseJsonOrUndefined(contents)
  const config = parsed === undefined ? null : parseConfig(parsed)
  if (config === null) {
    process.stderr.write(
      `thunderbolt: ignoring invalid config at ${path} — run \`thunderbolt config\` to recreate it.\n`,
    )
  }
  return config
}

/** Saves config in an owner-only directory (`0700`) and forces file mode to `0600`. */
export const saveConfig = async (config: CliConfig, path: string = configPath()): Promise<void> => {
  await writeSecureFile(dirname(path), path, `${JSON.stringify(config, null, 2)}\n`)
}

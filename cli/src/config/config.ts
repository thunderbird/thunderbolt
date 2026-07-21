/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Typed persistence for user-editable CLI defaults. */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { MODEL_PROVIDERS } from '../agent/types.ts'
import type { ModelProvider } from '../agent/types.ts'
import { configPath } from '../paths.ts'

const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** Minimal persisted CLI profile. */
export type CliConfig = {
  readonly provider: ModelProvider
  readonly model: string
  readonly apiKey?: string
  readonly baseUrl?: string
}

/** Narrows unknown JSON values to object records. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Narrows user input to supported model providers. */
const isProvider = (value: unknown): value is ModelProvider =>
  typeof value === 'string' && (MODEL_PROVIDERS as readonly string[]).includes(value)

/** Validates unknown JSON and returns a minimal canonical config. */
const parseConfig = (value: unknown): CliConfig | null => {
  if (!isRecord(value) || !isProvider(value.provider) || typeof value.model !== 'string') return null
  if (value.apiKey !== undefined && typeof value.apiKey !== 'string') return null
  if (value.baseUrl !== undefined && typeof value.baseUrl !== 'string') return null

  return {
    provider: value.provider,
    model: value.model,
    ...(value.apiKey === undefined ? {} : { apiKey: value.apiKey }),
    ...(value.baseUrl === undefined ? {} : { baseUrl: value.baseUrl }),
  }
}

/** Loads config, treating missing, malformed, or invalid user input as absent. */
export const loadConfig = async (path: string = configPath()): Promise<CliConfig | null> => {
  try {
    const contents = await readFile(path, 'utf8')
    try {
      return parseConfig(JSON.parse(contents) as unknown)
    } catch (error) {
      if (error instanceof SyntaxError) return null
      throw error
    }
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Saves config in an owner-only directory and forces file mode to `0600`. */
export const saveConfig = async (config: CliConfig, path: string = configPath()): Promise<void> => {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
  await chmod(dir, DIR_MODE)
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: FILE_MODE })
  await chmod(path, FILE_MODE)
}

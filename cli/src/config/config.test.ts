/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { loadConfig, saveConfig } from './config.ts'
import type { CliConfig } from './config.ts'

const tempDirs: string[] = []
let stderr: ReturnType<typeof spyOn>

beforeEach(() => {
  stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
})

/** Allocates one nested config path and tracks its temp root for cleanup. */
const temporaryConfigPath = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'thunderbolt-config-'))
  tempDirs.push(dir)
  return join(dir, 'state', 'config.json')
}

/** Writes user-edited config text after creating its parent directory. */
const writeRawConfig = async (path: string, contents: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

afterEach(async () => {
  stderr.mockRestore()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('CLI config persistence', () => {
  test('roundtrips the typed config shape', async () => {
    const path = await temporaryConfigPath()
    const config: CliConfig = {
      provider: 'openai-compat',
      model: 'local-model',
      apiKey: 'secret',
      baseUrl: 'http://localhost:11434/v1',
    }

    await saveConfig(config, path)

    expect(await loadConfig(path)).toEqual(config)
  })

  test('writes config owner-only with mode 0600', async () => {
    const path = await temporaryConfigPath()

    await saveConfig({ provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'secret' }, path)

    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test('treats a missing file as absent with no stderr note', async () => {
    expect(await loadConfig(await temporaryConfigPath())).toBeNull()
    expect(stderr).not.toHaveBeenCalled()
  })

  test('treats malformed JSON as absent and reports the file on stderr', async () => {
    const path = await temporaryConfigPath()
    await writeRawConfig(path, '{not-json')

    expect(await loadConfig(path)).toBeNull()
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(String(stderr.mock.calls[0]?.[0])).toContain(path)
  })

  test('treats an invalid config shape as absent and reports the file on stderr', async () => {
    const path = await temporaryConfigPath()
    await writeRawConfig(path, JSON.stringify({ provider: 'bogus', model: 42 }))

    expect(await loadConfig(path)).toBeNull()
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(String(stderr.mock.calls[0]?.[0])).toContain(path)
  })
})

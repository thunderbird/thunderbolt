/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { defaultModelId } from '../../../shared/defaults/models.ts'
import { childProcessBarrierModuleUrl, spawnBarrierChild } from '../lib/child-process-test-barrier.ts'
import type { CliConfig } from '../provider-runtime/types.ts'
import { loadConfig, saveConfig } from './config.ts'

const tempDirs: string[] = []
const configModuleUrl = new URL('./config.ts', import.meta.url).href

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

/** Starts one independent config writer that loads before waiting at the shared barrier. */
const spawnConfigWriter = (path: string, activeProviderId: string) =>
  spawnBarrierChild(
    `
      import { waitForParentRelease } from ${JSON.stringify(childProcessBarrierModuleUrl)}
      import { loadConfig, saveConfig } from ${JSON.stringify(configModuleUrl)}
      const [path, activeProviderId] = process.argv.slice(1)
      const config = await loadConfig(path)
      if (config === null) throw new Error('missing config')
      await waitForParentRelease()
      try {
        await saveConfig({ ...config, activeProviderId: activeProviderId === 'null' ? null : activeProviderId }, path)
        console.log('saved')
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error))
      }
    `,
    [path, activeProviderId],
  )

/** Creates a representative valid v3 config. */
const createConfig = (): CliConfig => ({
  version: 3,
  activeProviderId: 'profile-openai',
  thunderbolt: { defaultModelId },
  providers: [
    {
      id: 'profile-openai',
      label: 'Work OpenAI',
      provider: 'openai',
      defaultModel: 'gpt-5.6-sol',
      apiKey: 'secret',
      credentialStatus: 'authenticated',
    },
  ],
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('CLI config v3 persistence', () => {
  test('roundtrips the strict versioned config through the canonical API', async () => {
    const path = await temporaryConfigPath()
    const config = createConfig()

    await saveConfig(config, path)

    expect(await loadConfig(path)).toEqual(config)
  })

  test('rejects one of two cross-process writers that loaded the same predecessor', async () => {
    const path = await temporaryConfigPath()
    await saveConfig(createConfig(), path)
    const writers = await Promise.all([spawnConfigWriter(path, 'thunderbolt'), spawnConfigWriter(path, 'null')])
    writers.forEach((writer) => writer.release())

    const outputs = await Promise.all(writers.map((writer) => writer.result()))
    expect(outputs.sort()).toEqual(['Provider configuration changed on disk. Retry the command.', 'saved'])
    const persisted = await loadConfig(path)
    if (persisted === null) throw new Error('one config writer must persist')
    expect(['thunderbolt', null]).toContain(persisted.activeProviderId)
  })

  test('roundtrips Fireworks protocol metadata only on Fireworks profiles', async () => {
    const path = await temporaryConfigPath()
    const fireworks: CliConfig = {
      ...createConfig(),
      activeProviderId: 'profile-fireworks',
      providers: [
        {
          id: 'profile-fireworks',
          label: 'Fireworks',
          provider: 'fireworks',
          defaultModel: 'future-fireworks-model',
          modelApi: 'openai-completions',
          apiKey: 'secret',
          credentialStatus: 'authenticated',
        },
      ],
    }

    await saveConfig(fireworks, path)
    expect(await loadConfig(path)).toEqual(fireworks)

    const invalidPath = await temporaryConfigPath()
    await writeRawConfig(
      invalidPath,
      JSON.stringify({
        ...createConfig(),
        providers: [{ ...createConfig().providers[0], modelApi: 'openai-completions' }],
      }),
    )
    await expect(loadConfig(invalidPath)).rejects.toMatchObject({ code: 'config-invalid' })
  })

  test('writes config owner-only with mode 0600', async () => {
    const path = await temporaryConfigPath()

    await saveConfig(createConfig(), path)

    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test('returns null for a missing file', async () => {
    expect(await loadConfig(await temporaryConfigPath())).toBeNull()
  })

  test('rejects malformed JSON without changing its bytes', async () => {
    const path = await temporaryConfigPath()
    const original = '{not-json'
    await writeRawConfig(path, original)

    await expect(loadConfig(path)).rejects.toMatchObject({
      code: 'config-invalid',
    })
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  test('rejects invalid v3 schemas without changing their bytes', async () => {
    const path = await temporaryConfigPath()
    const original = `${JSON.stringify({ ...createConfig(), providers: [{ id: 'incomplete' }] })}\n`
    await writeRawConfig(path, original)

    await expect(loadConfig(path)).rejects.toMatchObject({ code: 'config-invalid' })
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  test('rejects a non-UUID managed default model without changing its bytes', async () => {
    const path = await temporaryConfigPath()
    const original = `${JSON.stringify({ ...createConfig(), thunderbolt: { defaultModelId: 'not-a-uuid' } })}\n`
    await writeRawConfig(path, original)

    await expect(loadConfig(path)).rejects.toMatchObject({ code: 'config-invalid' })
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  test('rejects future versions without changing their bytes', async () => {
    const path = await temporaryConfigPath()
    const original = `${JSON.stringify({ ...createConfig(), version: 4 })}\n`
    await writeRawConfig(path, original)

    await expect(loadConfig(path)).rejects.toMatchObject({
      code: 'config-version-unsupported',
    })
    expect(await readFile(path, 'utf8')).toBe(original)
  })
})

describe('legacy CLI config migration', () => {
  test('migrates a saved-key built-in profile as active and not-authenticated', async () => {
    const path = await temporaryConfigPath()
    await writeRawConfig(path, JSON.stringify({ provider: 'openai', model: 'gpt-5.6-sol', apiKey: 'stored-key' }))

    const migrated = await loadConfig(path)
    const profile = migrated?.providers[0]

    expect(migrated).toMatchObject({ version: 3, thunderbolt: { defaultModelId } })
    expect(migrated?.activeProviderId).toBe(profile?.id)
    expect(profile).toMatchObject({
      provider: 'openai',
      defaultModel: 'gpt-5.6-sol',
      apiKey: 'stored-key',
      credentialStatus: 'not-authenticated',
    })
    expect(await loadConfig(path)).toEqual(migrated)
  })

  test('migrates a dedicated-environment built-in profile without treating it as validated', async () => {
    const path = await temporaryConfigPath()
    const previousKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'environment-key'
    await writeRawConfig(path, JSON.stringify({ provider: 'anthropic', model: 'claude-opus-4-8' }))

    try {
      const migrated = await loadConfig(path)
      const profile = migrated?.providers[0]

      expect(profile).toMatchObject({
        provider: 'anthropic',
        apiKey: null,
        credentialStatus: 'not-authenticated',
      })
      expect(migrated?.activeProviderId).toBe(profile?.id)
    } finally {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousKey
    }
  })

  test('migrates an OpenAI-compatible profile with its stored key and endpoint', async () => {
    const path = await temporaryConfigPath()
    await writeRawConfig(
      path,
      JSON.stringify({
        provider: 'openai-compat',
        model: 'local-model',
        apiKey: 'compat-key',
        baseUrl: 'http://localhost:11434/v1',
      }),
    )

    const migrated = await loadConfig(path)
    const profile = migrated?.providers[0]

    expect(profile).toMatchObject({
      provider: 'openai-compat',
      defaultModel: 'local-model',
      apiKey: 'compat-key',
      baseUrl: 'http://localhost:11434/v1',
      credentialStatus: 'not-authenticated',
    })
    expect(migrated?.activeProviderId).toBe(profile?.id)
  })

  test('migrates a keyless profile as active and not-authenticated', async () => {
    const path = await temporaryConfigPath()
    await writeRawConfig(path, JSON.stringify({ provider: 'google', model: 'gemini-test' }))

    const migrated = await loadConfig(path)
    const profile = migrated?.providers[0]

    expect(profile).toMatchObject({
      provider: 'google',
      defaultModel: 'gemini-test',
      apiKey: null,
      credentialStatus: 'not-authenticated',
    })
    expect(migrated?.activeProviderId).toBe(profile?.id)
  })

  test('keeps an unknown legacy Fireworks model active but requires protocol repair', async () => {
    const path = await temporaryConfigPath()
    await writeRawConfig(
      path,
      JSON.stringify({ provider: 'fireworks', model: 'future-fireworks-model', apiKey: 'legacy-key' }),
    )

    const migrated = await loadConfig(path)
    const migratedProfile = migrated?.providers[0]

    expect(migratedProfile).toMatchObject({
      provider: 'fireworks',
      defaultModel: 'future-fireworks-model',
      credentialStatus: 'authentication-required',
    })
    expect(migratedProfile).not.toHaveProperty('modelApi')
    expect(migrated?.activeProviderId).toBe(migratedProfile?.id)
  })
})

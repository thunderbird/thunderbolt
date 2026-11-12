/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import './memory-environment'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { updateModel } from '@/dal/models'
import { getDb } from '@/db/database'
import { setAuthToken } from '@/lib/auth-token'
import { createClient } from '@/lib/http'
import { getLocalSetting, useLocalSettingsStore } from '@/stores/local-settings-store'
import { getModelId } from './scenarios'
import { serializeArtifact } from './stats'

const providerCredential = { key: '' }

/** Select a backend and authenticate through its existing supported test-session flow. */
export const configureMemoryEval = async (): Promise<void> => {
  if (process.env.EVAL_CLOUD_URL) {
    useLocalSettingsStore.getState().setLocalSetting('cloudUrl', process.env.EVAL_CLOUD_URL)
  }
  if (process.env.EVAL_AUTH_TOKEN) {
    setAuthToken(process.env.EVAL_AUTH_TOKEN)
  }
  if (process.env.EVAL_ANONYMOUS_AUTH === '1' && !process.env.EVAL_AUTH_TOKEN) {
    const response = await createClient({ prefixUrl: getLocalSetting('cloudUrl') }).post('api/auth/sign-in/anonymous', {
      json: {},
    })
    const token = response.headers.get('set-auth-token')
    if (!token) {
      throw new Error('Anonymous eval sign-in returned no bearer token')
    }
    process.env.EVAL_AUTH_TOKEN = token
    setAuthToken(token)
  }
}

/** Use the same Opus 5.5 model through an explicitly authorized OpenRouter credential, only in the isolated eval DB. */
export const configureEvalModels = async (): Promise<void> => {
  if (!process.env.EVAL_OPENROUTER_KEY_FILE) {
    return
  }
  const key = providerCredential.key || readFileSync(process.env.EVAL_OPENROUTER_KEY_FILE, 'utf8').trim()
  providerCredential.key = key
  if (!key) {
    throw new Error('The authorized OpenRouter credential file is empty')
  }
  await updateModel(getDb(), getModelId('opus'), {
    provider: 'openrouter',
    model: 'anthropic/claude-opus-5.5',
    url: 'https://openrouter.ai/api/v1',
    apiKey: key,
    providerConnectionId: null,
  })
}

/** Redact both backend and authorized provider credentials from every memory-eval artifact. */
export const serializeMemoryEvalArtifact = (value: unknown): string =>
  serializeArtifact(value, [process.env.EVAL_AUTH_TOKEN ?? '', providerCredential.key])

/** Fingerprint the memory/tool implementation, including new uncommitted files, alongside the base revision. */
export const getMemoryEvalVersion = (): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        [
          '../../memory/instructions.ts',
          '../../memory/context.ts',
          '../../memory/tools.ts',
          '../../memory/access.ts',
          '../../memory/providers.ts',
          '../../memory/selection.ts',
          '../../memory/revision.ts',
          '../../memory/mcp-access.ts',
          '../../lib/mcp-client-identity.ts',
          '../../memory/limits.ts',
          '../../memory/compact.ts',
          '../../dal/memories.ts',
          '../../session-history/tools.ts',
          '../../session-history/limits.ts',
          '../prompt.ts',
          '../fetch.ts',
          '../../acp/built-in-adapter.ts',
          './memory-scenarios.ts',
        ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')),
      ),
    )
    .digest('hex')

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import './memory-environment'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getModel } from '@/dal/models'
import { getModelProfile } from '@/dal/model-profiles'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { getAuthToken } from '@/lib/auth-token'
import { createProxyFetch } from '@/lib/proxy-fetch'
import { compactMemories } from '@/memory/compact'
import { memoryByteLength } from '@/memory/limits'
import { getLocalSetting } from '@/stores/local-settings-store'
import {
  configureEvalModels,
  configureMemoryEval,
  getMemoryEvalVersion,
  serializeMemoryEvalArtifact,
} from './memory-runtime'
import { evalModels } from './scenarios'
import { positiveFinite } from './stats'

const facts = [
  {
    content:
      'The user prefers using Celsius for temperatures, and Fahrenheit should only be used if the user explicitly asks for it.',
    required: [/celsius/i, /fahrenheit/i, /request|ask/i, /only|unless|explicit|on request/i],
  },
  {
    content: 'The user is the maintainer of Project Juniper, but the user is not the owner of Project Juniper.',
    required: [/juniper/i, /maintain/i, /not.{0,20}own|doesn.t.{0,20}own/i],
  },
  {
    content: 'The user does not want phone calls on Fridays, with the only exception being a production outage.',
    required: [
      /friday/i,
      /production/i,
      /outage/i,
      /except|unless|only/i,
      /no.{0,20}call|avoid.{0,20}call|call.{0,20}(not|none)|not.{0,20}call|call.{0,20}only|only.{0,20}call/i,
    ],
  },
]

type CompactionTrial = {
  model: string
  modelId: string
  sample: number
  status: 'pass' | 'fail' | 'error'
  beforeBytes: number
  afterBytes?: number
  replacement?: string
  failures: string[]
}

/** Run the actual Settings compaction function over facts containing negations and exceptions. */
const runCompaction = async (id: string, name: string, sample: number): Promise<CompactionTrial> => {
  await setupTestDatabase()
  try {
    await configureEvalModels()
    const model = await getModel(getDb(), id)
    if (!model) {
      throw new Error(`Eval model missing: ${name}`)
    }
    const profile = await getModelProfile(getDb(), id)
    const content = facts.map(({ content }) => content).join('\n')
    const beforeBytes = memoryByteLength(content)
    const trial: CompactionTrial = {
      model: name,
      modelId: model.model,
      sample,
      status: 'error',
      beforeBytes,
      failures: [],
    }
    try {
      const proxyFetch = createProxyFetch({ cloudUrl: getLocalSetting('cloudUrl'), getProxyAuthToken: getAuthToken })
      const replacement = await compactMemories({ content, model, profile, getProxyFetch: () => proxyFetch })
      const failures = facts.flatMap((fact, index) => {
        return fact.required
          .filter((pattern) => !pattern.test(replacement))
          .map((pattern) => `Fact ${index + 1} failed preservation check ${pattern.source}`)
      })
      const afterBytes = memoryByteLength(replacement)
      if (afterBytes >= beforeBytes) {
        failures.push('Proposal is not shorter')
      }
      return { ...trial, replacement, afterBytes, failures, status: failures.length ? 'fail' : 'pass' }
    } catch (error) {
      return { ...trial, failures: [String(error)] }
    }
  } finally {
    await teardownTestDatabase()
  }
}

const main = async (): Promise<number> => {
  const samples = positiveFinite(process.env.EVAL_SAMPLES, 3, 'EVAL_SAMPLES')
  if (!Number.isInteger(samples)) {
    throw new Error('EVAL_SAMPLES must be an integer')
  }
  await configureMemoryEval()
  const requested = process.env.EVAL_MODELS?.split(',').map((name) => name.trim())
  if (requested?.some((name) => !evalModels.some((model) => model.name === name))) {
    throw new Error('Unknown eval model')
  }
  const selected = evalModels.filter((model) => !requested || requested.includes(model.name))
  const output = process.env.EVAL_OUTPUT ?? 'evals/memory-compaction.json'
  mkdirSync(dirname(output), { recursive: true })
  const trials: CompactionTrial[] = []
  for (const model of selected) {
    for (const index of Array.from({ length: samples }, (_, index) => index)) {
      process.stdout.write(`Compacting with ${model.name}, sample ${index + 1}/${samples}\n`)
      const trial = await runCompaction(model.id, model.name, index + 1)
      trials.push(trial)
      writeFileSync(
        output,
        serializeMemoryEvalArtifact({
          execution: 'Production compactMemories → resolvePiModel → models.streamSimple',
          memoryImplementationVersion: getMemoryEvalVersion(),
          fixtures: facts.map(({ content, required }) => ({
            content,
            checks: required.map((pattern) => pattern.source),
          })),
          planned: selected.length * samples,
          trials,
        }),
      )
      process.stdout.write(`${trial.status}: ${model.name} (${trial.beforeBytes} → ${trial.afterBytes ?? '?'} bytes)\n`)
    }
  }
  return trials.every((trial) => trial.status === 'pass') ? 0 : 1
}

try {
  process.exit(await main())
} catch (error) {
  console.error(JSON.parse(serializeMemoryEvalArtifact(String(error))))
  process.exit(2)
}

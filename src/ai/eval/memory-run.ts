/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import './memory-environment'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sql } from 'drizzle-orm'
import { createBuiltInAdapter } from '@/acp/built-in-adapter'
import { updateSettings } from '@/dal/settings'
import { getMemoryDocument } from '@/dal/memories'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable } from '@/db/tables'
import { builtInAgent } from '@/defaults/agents'
import { buildCreateSql } from '@/search/fts-setup'
import { getLocalSetting } from '@/stores/local-settings-store'
import {
  configureEvalModels,
  configureMemoryEval,
  getMemoryEvalVersion,
  serializeMemoryEvalArtifact,
} from './memory-runtime'
import { checkMemoryState, getMemoryScenarios, type MemoryEvalScenario } from './memory-scenarios'
import { runScenario, runTrial } from './runner'
import { getSystemPromptVersion, positiveFinite, trialVerdict } from './stats'
import type { EvalTrial } from './types'
import { restoreConsole, silenceConsole } from './ui'

/** Seed actual tables and the same FTS schema used by the app, without unrelated user data. */
const seedFixture = async ({ fixture, threadId }: MemoryEvalScenario): Promise<void> => {
  const db = getDb()
  await updateSettings(db, {
    memory_enabled: fixture.memoryEnabled ?? true,
    session_history_enabled: fixture.historyEnabled ?? true,
    memory_content: fixture.memoryContent ?? '',
  })
  await db
    .insert(chatThreadsTable)
    .values({ id: threadId!, title: 'Isolated memory eval', isEncrypted: fixture.privateChat ? 1 : 0 })
  await db.run(sql.raw(buildCreateSql()))
  for (const [index, session] of (fixture.sessions ?? []).entries()) {
    const messageId = `019c0000-0000-7000-8001-${String(index).padStart(12, '0')}`
    const deletedAt = session.deleted ? '2026-01-01T00:00:00.000Z' : null
    await db.insert(chatThreadsTable).values({
      id: session.id,
      title: session.title,
      isEncrypted: session.isPrivate ?? 0,
      deletedAt,
    })
    await db.insert(chatMessagesTable).values({
      id: messageId,
      chatThreadId: session.id,
      role: 'user',
      content: session.content,
      parts: [{ type: 'text', text: session.content }],
    })
    // Keeping deleted rows in this test index also exercises the live-row recheck.
    await db.run(sql`INSERT INTO search_index (id, entity_type, parent_id, title, body)
      VALUES (${messageId}, 'message', ${session.id}, '', ${session.content})`)
    await db.run(sql`INSERT INTO search_index (id, entity_type, parent_id, title, body)
      VALUES (${session.id}, 'chat', NULL, ${session.title}, '')`)
  }
}

/** Each attempt owns a fresh DB and harness, so previous memories cannot contaminate a later trial. */
const executeIsolated = async (scenario: MemoryEvalScenario) => {
  await setupTestDatabase()
  const adapter = createBuiltInAdapter(builtInAgent)
  try {
    await configureEvalModels()
    await seedFixture(scenario)
    const attempt = await runScenario(scenario, adapter)
    const document = await getMemoryDocument(getDb())
    const failures = checkMemoryState(scenario.memoryState, document.content)
    attempt.instrumentation.preflight = {
      adapterPreflight: attempt.instrumentation.preflight,
      scenarioFixture: scenario.fixture,
      memoryStateAfter: document,
      productionAdapter: true,
      isolatedDatabase: true,
    }
    if (failures.length) {
      attempt.result.passed = false
      attempt.result.failures.push(...failures)
      // Missing writes after a timeout are unresolved; forbidden writes are still provable failures.
      attempt.provenFailure ||=
        attempt.status === 'completed' ||
        (scenario.memoryState.exact !== undefined && document.content !== (scenario.fixture.memoryContent ?? ''))
      attempt.verdicts.memoryState = attempt.status === 'completed' ? 'fail' : 'unknown'
    } else {
      attempt.verdicts.memoryState = attempt.status === 'completed' ? 'pass' : 'unknown'
    }
    return attempt
  } finally {
    adapter.disconnect()
    await teardownTestDatabase()
  }
}

/** Summarize all trials; infrastructure errors never enter the behavioral pass denominator. */
const renderReport = (trials: EvalTrial[], planned: number, samples: number): string => {
  const lines = [
    '# Memory and session tool evals',
    '',
    `Production built-in adapter; isolated SQLite fixtures; ${samples} sample(s) per model/scenario.`,
    `${trials.length}/${planned} planned trials completed. Tool calls, retrieved facts, output sizes, and persisted memory outcomes are scored deterministically.`,
    '',
    '| Model | Pass | Fail | Error |',
    '| --- | ---: | ---: | ---: |',
    ...[...new Set(trials.map((trial) => trial.scenario.modelName))].map((model) => {
      const verdicts = trials.filter((trial) => trial.scenario.modelName === model).map(trialVerdict)
      return `| ${model} | ${verdicts.filter((v) => v === 'pass').length} | ${verdicts.filter((v) => v === 'fail').length} | ${verdicts.filter((v) => v === 'error').length} |`
    }),
    '',
    '| Scenario | Sample | Result | Details |',
    '| --- | ---: | --- | --- |',
    ...trials.map(
      (trial) =>
        `| ${trial.scenario.id} | ${trial.index + 1} | ${trialVerdict(trial)} | ${trial.attempts.at(-1)?.result.failures.join('; ').replaceAll('|', '\\|').replaceAll('\n', ' ') ?? ''} |`,
    ),
    '',
    'Fixtures contain invented data only. Full tool trajectories and database snapshots are in the adjacent JSONL artifact. These model evals complement deterministic permission, sync, and context-budget tests; they do not prove perfect model behavior.',
    '',
  ]
  return lines.join('\n')
}

const main = async (): Promise<number> => {
  const samples = positiveFinite(process.env.EVAL_SAMPLES, 3, 'EVAL_SAMPLES')
  if (!Number.isInteger(samples)) {
    throw new Error('EVAL_SAMPLES must be an integer')
  }
  positiveFinite(process.env.EVAL_TIMEOUT, 120000, 'EVAL_TIMEOUT')
  process.env.EVAL_TIMEOUT ??= '120000'
  await configureMemoryEval()
  const split = (value: string | undefined) => value?.split(',').map((part) => part.trim())
  const scenarios = getMemoryScenarios(split(process.env.EVAL_MODELS), split(process.env.EVAL_SCENARIOS))
  const outputPath = process.env.EVAL_OUTPUT ?? 'evals/memory-results.md'
  const journalPath = outputPath.replace(/\.md$/, '') + '.jsonl'
  mkdirSync(dirname(outputPath), { recursive: true })
  const manifest = {
    type: 'manifest',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    systemPromptVersion: getSystemPromptVersion(),
    memoryImplementationVersion: getMemoryEvalVersion(),
    samples,
    planned: scenarios.length * samples,
    scenarios,
    auth: process.env.EVAL_AUTH_TOKEN ? 'present' : 'absent',
    cloudUrl: getLocalSetting('cloudUrl'),
    opusTransport: process.env.EVAL_OPENROUTER_KEY_FILE
      ? 'OpenRouter: anthropic/claude-opus-5.5'
      : 'Thunderbolt: opus-5-5',
  }
  writeFileSync(journalPath, serializeMemoryEvalArtifact(manifest) + '\n')
  const trials: EvalTrial[] = []
  for (const scenario of scenarios) {
    for (const index of Array.from({ length: samples }, (_, index) => index)) {
      process.stdout.write(`Running ${scenario.id} sample ${index + 1}/${samples}\n`)
      silenceConsole()
      const trial = await runTrial(scenario, index, () => executeIsolated(scenario)).finally(restoreConsole)
      trials.push(trial)
      appendFileSync(journalPath, serializeMemoryEvalArtifact({ type: 'trial', trial }) + '\n')
      writeFileSync(outputPath, renderReport(trials, manifest.planned, samples))
      process.stdout.write(`${trialVerdict(trial)}: ${scenario.id}\n`)
    }
  }
  process.stdout.write(`Report: ${outputPath}\n`)
  return trials.every((trial) => trialVerdict(trial) === 'pass') ? 0 : 1
}

try {
  process.exit(await main())
} catch (error) {
  restoreConsole()
  console.error(JSON.parse(serializeMemoryEvalArtifact(String(error))))
  process.exit(2)
}

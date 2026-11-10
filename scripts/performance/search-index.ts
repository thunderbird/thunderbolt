/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Native SQLite attribution only: this excludes PowerSync/WASM, browser CPU and device latency. */
import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { Database } from 'bun:sqlite'
import { buildBackfillSql, buildCreateSql, buildDropSql, buildTriggerSql } from '../../src/search/fts-setup'
import { planSearchQuery } from '../../src/search/query-plan'
import { searchEntities } from '../../src/search/registry'
import { buildSearchStatement } from '../../src/search/use-search'
import { percentile } from './metrics'
import { positiveInteger } from './options'

const { values } = parseArgs({
  options: { messages: { type: 'string' }, samples: { type: 'string' }, output: { type: 'string' } },
})
const messageCounts = (values.messages ?? '10000,100000')
  .split(',')
  .map((value) => positiveInteger('--messages', value))
const samples = positiveInteger('--samples', values.samples ?? 9)
if (messageCounts.some((count) => !Number.isInteger(count) || count < 50 || count % 50 !== 0)) {
  throw new Error('--messages must contain positive multiples of 50, separated by commas')
}
if (!Number.isInteger(samples) || samples < 3) {
  throw new Error('--samples must be an integer of at least 3')
}

const body = 'Discuss rendering performance, database indexing, memory usage, and responsive interactions. '.repeat(8)
const internalName = (tableName: string) => `ps_data__${tableName}`
const idAt = (type: 'chat' | 'message', index: number) => `${type}-${index.toString().padStart(8, '0')}`

/** Measure individual completed SQLite operations, keeping fixture construction outside the samples. */
const measure = (operation: () => void, count = samples) => {
  const samplesMs = Array.from({ length: count }, () => {
    const start = performance.now()
    operation()
    return performance.now() - start
  })
  return { medianMs: percentile(samplesMs, 0.5)!, samplesMs }
}

/** Reproduce the prior trigger behavior without copying the current schema or backfill implementation. */
const referenceTrigger = (sql: string) => sql.replace(/( AFTER UPDATE ON \S+) WHEN .+? BEGIN /, '$1 BEGIN ')

/** Install the actual index and triggers; the reference differs only by removing UPDATE's WHEN guard. */
const rebuildIndex = (db: Database, guarded: boolean) => {
  db.transaction(() => {
    for (const statement of buildDropSql()) {
      db.run(statement)
    }
    db.run(buildCreateSql())
    for (const config of searchEntities) {
      for (const statement of buildTriggerSql(config, internalName(config.tableName))) {
        db.run(guarded ? statement : referenceTrigger(statement))
      }
      db.run(buildBackfillSql(config, internalName(config.tableName)))
    }
  })()
}

type SearchHit = { id: string; entity_type: string; parent_id: string | null; title: string | null; snippet: string }

/** Populate PowerSync-shaped backing rows: 50 messages per chat, with multilingual and rare-term content. */
const seed = (db: Database, messageCount: number) => {
  for (const config of searchEntities) {
    db.run(`CREATE TABLE ${internalName(config.tableName)} (id TEXT PRIMARY KEY, data TEXT)`)
  }
  const insertMessage = db.prepare('INSERT INTO ps_data__chat_messages VALUES (?, ?)')
  const insertChat = db.prepare('INSERT INTO ps_data__chat_threads VALUES (?, ?)')
  db.transaction(() => {
    for (let index = 0; index < messageCount / 50; index++) {
      insertChat.run(idAt('chat', index), JSON.stringify({ title: `Project conversation ${index}`, deleted_at: null }))
    }
    for (let index = 0; index < messageCount; index++) {
      const content = `${body}${index % 100 === 0 ? ' Rarefinding 東京の天気' : ''}`
      insertMessage.run(
        idAt('message', index),
        JSON.stringify({
          content,
          chat_thread_id: idAt('chat', Math.floor(index / 50)),
          deleted_at: null,
          parts: [{ type: 'text', text: content }],
          metadata: {},
        }),
      )
    }
  })()
}

/** Compare non-searchable writes, genuine content changes, search reads and the one-time index rebuild. */
const run = (messageCount: number, guarded: boolean) => {
  const db = new Database(':memory:')
  try {
    seed(db, messageCount)
    rebuildIndex(db, guarded)
    const target = idAt('message', messageCount - 1)
    const targetChat = idAt('chat', messageCount / 50 - 1)
    const updateMetadata = db.prepare(
      "UPDATE ps_data__chat_messages SET data=json_set(data, '$.metadata', json(?)) WHERE id=?",
    )
    const updateContext = db.prepare(
      "UPDATE ps_data__chat_threads SET data=json_set(data, '$.context_size', ?) WHERE id=?",
    )
    const updateContent = db.prepare("UPDATE ps_data__chat_messages SET data=json_set(data, '$.content', ?) WHERE id=?")
    let revision = 0
    const metadata = measure(() => updateMetadata.run(JSON.stringify({ usage: { totalTokens: ++revision } }), target))
    const context = measure(() => updateContext.run(++revision, targetChat))
    const content = measure(() => updateContent.run(`${body} ${++revision}`, target))
    updateMetadata.finalize()
    updateContext.finalize()
    updateContent.finalize()
    const searches = ['render', 'Rarefinding', '天気'].map((query) => {
      const statement = buildSearchStatement(planSearchQuery(query))
      const compiled = db.prepare<SearchHit, string[]>(statement.sql)
      const queryPlan = db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
      const result = {
        query,
        ...measure(() => void compiled.all(...statement.parameters)),
        results: compiled.all(...statement.parameters),
        plan: queryPlan.all(...statement.parameters),
      }
      compiled.finalize()
      queryPlan.finalize()
      return result
    })
    const rebuild = measure(() => rebuildIndex(db, guarded), Math.min(samples, 3))
    for (const search of searches) {
      const statement = buildSearchStatement(planSearchQuery(search.query))
      assert.deepEqual(db.query(statement.sql).all(...statement.parameters), search.results)
    }
    return {
      messageCount,
      chatCount: messageCount / 50,
      bodyCharacters: body.length,
      guarded,
      metadata,
      context,
      content,
      rebuild,
      searches,
      deletePlan: db
        .query('EXPLAIN QUERY PLAN DELETE FROM search_index WHERE id = ? AND entity_type = ?')
        .all(target, 'message'),
    }
  } finally {
    db.close()
  }
}

const results = messageCounts.flatMap((count) => {
  const reference = run(count, false)
  const guarded = run(count, true)
  assert.deepEqual(
    guarded.searches.map(({ results }) => results),
    reference.searches.map(({ results }) => results),
  )
  return [reference, guarded]
})
const report = {
  runtime: `Bun ${Bun.version}`,
  platform: process.platform,
  sqlite: 'native in-memory',
  samples,
  results,
}
if (values.output) {
  await Bun.write(values.output, JSON.stringify(report, null, 2))
}
console.log(
  JSON.stringify(
    {
      ...report,
      results: results.map(({ searches, deletePlan, ...result }) => ({
        ...result,
        searches: searches.map(({ query, medianMs, results }) => ({ query, medianMs, resultCount: results.length })),
        deletePlan,
      })),
    },
    null,
    2,
  ),
)

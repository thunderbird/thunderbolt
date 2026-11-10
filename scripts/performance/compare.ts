/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises'
import { percentile } from './metrics'
import { z } from 'zod'

const metric = z.number().finite().nonnegative()
const sampleSchema = z.object({
  run: z.number().int().positive(),
  profile: z.enum(['desktop', 'mobile']),
  name: z.string().min(1),
  taskMs: metric,
  actionMs: metric,
  frameMaxMs: metric.nullable(),
  blockingMs: metric.nullable(),
  reactCommits: metric,
  heapBytes: metric,
  nodes: metric,
})
const reportSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  fixtureVersion: z.number().int().positive().optional(),
  measurement: z.literal('assertion-inclusive-v1').optional(),
  completed: z.boolean(),
  browser: z.string().min(1),
  platform: z.string().min(1),
  cpuThrottle: metric.min(1),
  diagnosticTrace: z.boolean(),
  runs: z.number().int().positive(),
  samples: z.array(sampleSchema).min(1),
})
type Sample = z.infer<typeof sampleSchema>
type Report = z.infer<typeof reportSchema>

/** Parse only full-suite report shapes; matching unknown methods are not comparable full-suite runs. */
export const readFullReport = (value: unknown): Report => {
  const method = typeof value === 'object' && value !== null && 'measurement' in value ? value.measurement : undefined
  if (method === 'paired-targeted-v1') {
    throw new Error('Paired reports already compare their own before/after samples; use the paired runner summary')
  }
  if (method === 'startup-v1') {
    throw new Error('Startup reports use navigation and input-ready milestones; inspect startup samples separately')
  }
  if (method !== undefined && method !== 'assertion-inclusive-v1') {
    throw new Error('Only full-suite assertion-inclusive reports are supported by perf:compare')
  }
  const report = reportSchema.parse(value)
  const repetitions = new Map<string, Set<number>>()
  for (const sample of report.samples) {
    const key = `${sample.profile}/${sample.name}`
    const runs = repetitions.get(key) ?? new Set<number>()
    if (runs.has(sample.run)) {
      throw new Error(`Duplicate sample for ${key}, run ${sample.run}`)
    }
    runs.add(sample.run)
    repetitions.set(key, runs)
  }
  if (
    [...repetitions.values()].some((runs) => runs.size !== report.runs || [...runs].some((run) => run > report.runs))
  ) {
    throw new Error('Scenario repetition counts do not match runs')
  }
  return report
}

/** Reject unlike environments instead of presenting their difference as an optimization. */
export const validateComparison = (beforeInput: unknown, afterInput: unknown) => {
  const before = readFullReport(beforeInput)
  const after = readFullReport(afterInput)
  if (!before.completed || !after.completed) {
    throw new Error('Both runs must complete successfully')
  }
  if (before.diagnosticTrace || after.diagnosticTrace) {
    throw new Error('Trace runs are diagnostic, not benchmarks')
  }
  if ((before.fixtureVersion ?? 1) !== (after.fixtureVersion ?? 1)) {
    throw new Error('Mismatched fixtureVersion')
  }
  if ((before.measurement ?? 'assertion-inclusive-v1') !== (after.measurement ?? 'assertion-inclusive-v1')) {
    throw new Error('Mismatched measurement')
  }
  for (const key of ['schemaVersion', 'browser', 'platform', 'cpuThrottle', 'runs'] as const) {
    if (before[key] !== after[key]) {
      throw new Error(`Mismatched ${key}`)
    }
  }
  const keys = (report: Report) =>
    report.samples
      .map((sample) => `${sample.profile}/${sample.name}`)
      .sort()
      .join('\n')
  if (keys(before) !== keys(after)) {
    throw new Error('Scenario sets or repetition counts differ')
  }
  return { before, after }
}

if (import.meta.main) {
  const [beforePath, afterPath] = process.argv.slice(2)
  if (!beforePath || !afterPath) {
    throw new Error('Usage: bun scripts/performance/compare.ts before.json after.json')
  }
  const { before, after } = validateComparison(
    JSON.parse(await readFile(beforePath, 'utf8')),
    JSON.parse(await readFile(afterPath, 'utf8')),
  )
  const keys = [...new Set(before.samples.map(({ profile, name }) => `${profile}/${name}`))]
  const median = (report: Report, key: string, field: keyof Omit<Sample, 'profile' | 'name'>) =>
    percentile(
      report.samples
        .filter(({ profile, name }) => `${profile}/${name}` === key)
        .flatMap((sample) => (sample[field] === null ? [] : [sample[field]])),
      0.5,
    )
  const pair = (key: string, field: keyof Omit<Sample, 'profile' | 'name'>) =>
    `${median(before, key, field)?.toFixed(1) ?? 'n/a'} → ${median(after, key, field)?.toFixed(1) ?? 'n/a'}`
  console.log(`Medians of ${before.runs} fresh-context runs, ${before.cpuThrottle}× CPU, Chrome ${before.browser}.\n`)
  console.log('| Interaction | Action ms | Main-thread task ms | Max frame gap ms | Blocking ms | React commits |')
  console.log('| --- | ---: | ---: | ---: | ---: | ---: |')
  for (const key of keys) {
    console.log(
      `| ${key} | ${pair(key, 'actionMs')} | ${pair(key, 'taskMs')} | ${pair(key, 'frameMaxMs')} | ${pair(key, 'blockingMs')} | ${pair(key, 'reactCommits')} |`,
    )
  }
  console.log(
    '\nFrame gaps measure main-thread scheduling, not GPU FPS. Event Timing omits events below 16 ms. Heap values are snapshots, not proof of leaks. Action time includes Playwright waits; inspect raw reports and traces to attribute delays.',
  )
}

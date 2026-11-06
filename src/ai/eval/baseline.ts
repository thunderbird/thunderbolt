/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acceptEval, serializeArtifact } from './stats'
import type { EvalManifest, EvalMetrics, EvalMetricsGroup, EvalScenarioComparison } from './types'

export type EvalBaseline = {
  schemaVersion: number
  generatedAt: string
  groupKey: string
  manifest?: EvalManifest
  group: EvalMetricsGroup
}

export type EvalMetricsComparison = {
  generatedAt: string
  acceptance: ReturnType<typeof acceptEval>
  groups: Record<
    string,
    {
      comparable: boolean
      reason: string
      treatment: { baseline: EvalManifest['treatment'] | null; current: EvalManifest['treatment'] }
      scenarios: Record<string, EvalScenarioComparison>
    }
  >
}

const identityFields = [
  'rubricHash',
  'judgePromptVersion',
  'judgeModelId',
  'samples',
  'timeout',
  'judgeTimeout',
  'providerKind',
] as const

/** Identify the first incompatible measurement field; treatments are allowed to change. */
export const baselineDifferences = (current: EvalManifest, baseline: EvalBaseline): string[] => {
  if (baseline.schemaVersion !== 4 || !baseline.manifest) {
    return ['schemaVersion']
  }
  const previous = baseline.manifest
  const sortedCells = (manifest: EvalManifest) =>
    [...manifest.cells].sort((left, right) => left.key.localeCompare(right.key))
  return [
    ...identityFields.filter((field) => current[field] !== previous[field]),
    ...(JSON.stringify(sortedCells(current)) !== JSON.stringify(sortedCells(previous))
      ? ['cells (aliases / actual model IDs)']
      : []),
  ]
}

/** Write deterministic cell files only from a complete matrix; failing quality is still a valid baseline. */
export const writeBaselineFiles = (
  metrics: EvalMetrics,
  directory: string,
  expectedGroupKeys: readonly string[],
): string[] => {
  const missing = expectedGroupKeys.filter(
    (key) => !metrics.groups[key] || !metrics.manifest.cells.some((cell) => cell.key === key),
  )
  if (metrics.schemaVersion !== 4 || metrics.manifest.partial || missing.length || metrics.harnessCrashed) {
    throw new Error(
      `Cannot regenerate eval baselines from partial metrics. Missing model/engine cells: ${missing.join(', ')}`,
    )
  }
  mkdirSync(directory, { recursive: true })
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    rmSync(join(directory, name))
  }
  return Object.entries(metrics.groups)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([groupKey, group]) => {
      const path = join(directory, `${groupKey.replace('/', '--')}.json`)
      writeFileSync(
        path,
        `${serializeArtifact({ schemaVersion: 4, generatedAt: metrics.generatedAt, manifest: metrics.manifest, groupKey, group }, undefined, 2)}\n`,
      )
      return path
    })
}

/** Keep old schema metadata for an explicit not-comparable verdict, never reinterpret its measurements. */
export const loadBaselineFiles = (directory: string): Record<string, EvalBaseline> => {
  if (!existsSync(directory)) {
    return {}
  }
  return Object.fromEntries(
    readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => {
        const baseline = JSON.parse(readFileSync(join(directory, name), 'utf8')) as EvalBaseline
        return [baseline.groupKey, baseline]
      }),
  )
}

/** Paired per-scenario valid-trial deltas, conditional on matching measurement identity. */
export const compareMetricsToBaselines = (
  metrics: EvalMetrics,
  baselines: Record<string, EvalBaseline>,
): EvalMetricsComparison => ({
  generatedAt: metrics.generatedAt,
  acceptance: acceptEval(metrics),
  groups: Object.fromEntries(
    metrics.manifest.cells.map(({ key }) => {
      const baseline = baselines[key]
      const differences = baseline ? baselineDifferences(metrics.manifest, baseline) : ['baseline absent']
      const comparable = differences.length === 0
      return [
        key,
        {
          comparable,
          reason: comparable ? 'comparable' : `not comparable: ${differences.join(', ')}`,
          treatment: { baseline: baseline?.manifest?.treatment ?? null, current: metrics.manifest.treatment },
          scenarios: Object.fromEntries(
            Object.entries(metrics.groups[key]?.scenarios ?? {}).map(([id, scenario]) => {
              const baselineRate = comparable ? (baseline.group.scenarios[id]?.rate ?? null) : null
              const delta =
                baselineRate === null || scenario.rate === null
                  ? null
                  : Number((scenario.rate - baselineRate).toFixed(6))
              return [
                id,
                {
                  baselineRate,
                  currentRate: scenario.rate,
                  delta,
                  direction:
                    delta === null
                      ? 'not comparable'
                      : delta === 0
                        ? 'unchanged'
                        : delta > 0
                          ? 'improved'
                          : 'regressed',
                },
              ]
            }),
          ),
        },
      ]
    }),
  ),
})

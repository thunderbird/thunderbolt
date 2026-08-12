/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { compareMetricsToBaselines, loadBaselineFiles, writeBaselineFiles } from './baseline'
import { evalModels } from './scenarios'
import type { EvalMetrics } from './types'

const defaultMetricsPath = 'evals/eval-metrics.json'
const defaultBaselineDirectory = 'src/ai/eval/baselines'
const expectedGroupKeys = evalModels.map(({ name, engineName }) => `${name}/${engineName}`)

const main = () => {
  const [command, metricsArgument, baselineArgument] = process.argv.slice(2)
  const metricsPath = metricsArgument ?? process.env.EVAL_METRICS_PATH ?? defaultMetricsPath
  const baselineDirectory = baselineArgument ?? process.env.EVAL_BASELINE_DIR ?? defaultBaselineDirectory
  const metrics = JSON.parse(readFileSync(metricsPath, 'utf8')) as EvalMetrics

  if (command === 'generate') {
    const written = writeBaselineFiles(metrics, baselineDirectory, expectedGroupKeys)
    process.stdout.write(`Wrote ${written.length} eval baseline file${written.length === 1 ? '' : 's'}.\n`)
    return
  }

  if (command === 'compare') {
    process.stdout.write(
      `${JSON.stringify(compareMetricsToBaselines(metrics, loadBaselineFiles(baselineDirectory)), null, 2)}\n`,
    )
    return
  }

  throw new Error('Usage: baseline-cli.ts <generate|compare> [metrics-path] [baseline-directory]')
}

if (import.meta.main) {
  main()
}

import { generateReport } from './report'
import { runSequential } from './runner'
import { getScenarios } from './scenarios'
import type { EvalResult } from './types'

const groupBy = <T>(items: T[], key: (item: T) => string): Record<string, T[]> =>
  items.reduce(
    (acc, item) => {
      const k = key(item)
      acc[k] ??= []
      acc[k].push(item)
      return acc
    },
    {} as Record<string, T[]>,
  )

export const verbose = process.argv.includes('--verbose')

const main = async () => {
  const modelFilter = process.env.EVAL_MODELS?.split(',').map((s) => s.trim())
  const modeFilter = process.env.EVAL_MODES?.split(',').map((s) => s.trim())
  const parallel = parseInt(process.env.EVAL_PARALLEL ?? '3')

  const scenarios = getScenarios(modelFilter, modeFilter)

  if (scenarios.length === 0) {
    console.error('No scenarios matched the filters.')
    console.error(`  EVAL_MODELS=${process.env.EVAL_MODELS ?? '(all)'}`)
    console.error(`  EVAL_MODES=${process.env.EVAL_MODES ?? '(all)'}`)
    process.exit(1)
  }

  console.log(`\nThunderbolt AI Eval Runner`)
  console.log(`${'='.repeat(40)}`)
  console.log(`Scenarios: ${scenarios.length}`)
  console.log(`Models: ${[...new Set(scenarios.map((s) => s.modelName))].join(', ')}`)
  console.log(`Modes: ${[...new Set(scenarios.map((s) => s.modeName))].join(', ')}`)
  console.log(`Parallel: ${parallel} (one per model)`)
  console.log(`Timeout: ${process.env.EVAL_TIMEOUT ?? '120000'}ms per scenario`)
  if (verbose) console.log(`Verbose: ON`)
  console.log(`${'='.repeat(40)}\n`)

  // Group scenarios by model for parallelization
  const byModel = groupBy(scenarios, (s) => s.modelName)
  const modelGroups = Object.entries(byModel)

  // Run model groups in parallel (up to `parallel` concurrent), scenarios within each model sequentially
  const allResults: EvalResult[] = []

  for (let i = 0; i < modelGroups.length; i += parallel) {
    const batch = modelGroups.slice(i, i + parallel)

    console.log(`Starting batch: ${batch.map(([model]) => model).join(', ')}`)

    const batchResults = await Promise.all(
      batch.map(async ([model, modelScenarios]) => {
        console.log(`\n--- ${model.toUpperCase()} (${modelScenarios.length} scenarios) ---`)
        return runSequential(modelScenarios)
      }),
    )

    allResults.push(...batchResults.flat())
  }

  generateReport(allResults)

  // Exit with non-zero if any failures
  const failCount = allResults.filter((r) => !r.passed).length
  if (failCount > 0) process.exit(1)
}

await main()

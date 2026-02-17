import { generateReport } from './report'
import { runSequential } from './runner'
import { getScenarios } from './scenarios'
import { initLayout, printFooter, printModelSection, restoreConsole, silenceConsole, teardownLayout } from './ui'

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

  // Suppress noisy console output from fetch.ts unless --verbose
  if (!verbose) silenceConsole()

  // Initialize terminal layout with fixed bottom progress bar
  initLayout(scenarios)

  const byModel = groupBy(scenarios, (s) => s.modelName)
  const modelGroups = Object.entries(byModel)

  // Run model groups in parallel batches (up to `parallel` concurrent models)
  const allResults: Awaited<ReturnType<typeof runSequential>>[] = []

  for (let i = 0; i < modelGroups.length; i += parallel) {
    const batch = modelGroups.slice(i, i + parallel)

    const batchResults = await Promise.all(
      batch.map(async ([model, modelScenarios]) => {
        printModelSection(model, modelScenarios.length)
        return runSequential(modelScenarios)
      }),
    )

    allResults.push(...batchResults)
  }

  const flatResults = allResults.flat()

  printFooter()
  teardownLayout()

  // Restore console for report generation
  restoreConsole()

  generateReport(flatResults)

  const failCount = flatResults.filter((r) => !r.passed).length
  if (failCount > 0) process.exit(1)
}

await main()

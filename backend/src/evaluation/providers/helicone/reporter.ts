/**
 * Helicone Reporter
 *
 * Console-based reporter for Helicone evaluations.
 * Scores are attached directly to requests via the API, not through the reporter.
 */

import type { Reporter, SuiteResult, TestCase, TestResult } from '../../core'
import type { ProviderOptions } from '../registry'

export const createHeliconeReporter = (options: ProviderOptions = {}): Reporter => {
  const { verbose = false } = options

  let startTime = 0
  let completed = 0
  let total = 0

  return {
    name: 'helicone',

    async onSuiteStart(suite, totalTests) {
      startTime = Date.now()
      total = totalTests
      completed = 0

      console.log('')
      console.log('═'.repeat(60))
      console.log(`🧪 ${suite.name.toUpperCase()}`)
      console.log('═'.repeat(60))
      console.log(`Model: ${suite.model}`)
      console.log(`Tests: ${totalTests}`)
      console.log(`Evaluators: ${suite.evaluatorCount}`)
      console.log(`Provider: Helicone`)
      console.log('')
    },

    onTestStart(_testCase: TestCase) {
      // No-op
    },

    async onTestComplete(result: TestResult) {
      completed++
      const statusIcon = result.passed ? '✅' : '❌'
      const time = `${(result.latencyMs / 1000).toFixed(1)}s`
      const name = result.testCaseName.slice(0, 40).padEnd(40)
      console.log(`[${String(completed).padStart(2)}/${total}] ${statusIcon}  ${name} ${time}`)

      if (verbose && Object.keys(result.scores).length > 0) {
        for (const [evalName, score] of Object.entries(result.scores)) {
          const icon = score.value >= 0.7 ? '🟢' : score.value >= 0.4 ? '🟡' : '🔴'
          console.log(`      ${icon} ${evalName}: ${(score.value * 100).toFixed(0)}%`)
        }
      }
    },

    async onSuiteComplete(result: SuiteResult) {
      const duration = (Date.now() - startTime) / 1000

      console.log('')
      console.log('═'.repeat(60))
      console.log('📊 RESULTS')
      console.log('═'.repeat(60))
      console.log(`Total: ${result.summary.total}`)
      console.log(
        `Passed: ${result.summary.passed} (${((result.summary.passed / result.summary.total) * 100).toFixed(0)}%)`,
      )
      console.log(`Failed: ${result.summary.failed}`)
      console.log(`Avg Score: ${(result.summary.avgScore * 100).toFixed(1)}%`)
      console.log(`Duration: ${duration.toFixed(1)}s`)
      console.log('')

      // Print by evaluator
      if (Object.keys(result.summary.scoresByEvaluator).length > 0) {
        console.log('Scores by evaluator:')
        for (const [evalName, avg] of Object.entries(result.summary.scoresByEvaluator)) {
          const icon = avg >= 0.7 ? '🟢' : avg >= 0.4 ? '🟡' : '🔴'
          console.log(`  ${icon} ${evalName}: ${(avg * 100).toFixed(0)}%`)
        }
        console.log('')
      }

      // Note about Helicone limitations
      console.log('ℹ️  Note: Helicone only syncs scores for trace evaluations.')
      console.log('   For behavioral/quality evals, use: bun run eval traces --provider helicone')
      console.log('   Or use LangSmith for full experiment tracking.')
      console.log('')
    },
  }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resolve } from 'node:path'
import type { JSONReport, JSONReportSuite } from '@playwright/test/reporter'

/** Return spec paths absent from the union of Playwright's collected files. */
export const findUncollectedSpecs = (specFiles: string[], collectedFiles: string[]): string[] => {
  const collected = new Set(collectedFiles.map((file) => resolve(file)))
  return specFiles.filter((file) => !collected.has(resolve(file)))
}

/** Extract files with actual tests, including tests nested in describe blocks. */
const collectSuiteFiles = (suites: JSONReportSuite[]): string[] =>
  suites.flatMap((suite) => [...suite.specs.map((spec) => spec.file), ...collectSuiteFiles(suite.suites ?? [])])

/** Ask Playwright to collect tests without starting browsers or services. */
const listSpecFiles = async (config: string): Promise<string[]> => {
  const result = await Bun.$`bunx playwright test --config ${config} --list --reporter=json`.quiet()
  const report: JSONReport = result.json()
  return collectSuiteFiles(report.suites).map((file) => resolve(report.config.rootDir, file))
}

if (import.meta.main) {
  const collectedFiles = await Promise.all(['playwright.config.ts', 'playwright.preview.config.ts'].map(listSpecFiles))
  const specFiles = Array.from(new Bun.Glob('e2e/**/*.spec.ts').scanSync())
  const uncollected = findUncollectedSpecs(specFiles, collectedFiles.flat())
  if (uncollected.length > 0) {
    console.error(`No Playwright project collects:\n${uncollected.join('\n')}`)
    console.error('Fix the testMatch in playwright.config.ts or playwright.preview.config.ts.')
    process.exit(1)
  }
  console.log(`All ${specFiles.length} e2e spec files are collected.`)
}

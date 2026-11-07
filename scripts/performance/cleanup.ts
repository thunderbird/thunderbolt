/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { writeFile } from 'node:fs/promises'

export type CleanupStep = { name: string; run: () => Promise<unknown> }

/** Attempt every artifact/cleanup step, preserving the original run error and recording secondary failures. */
export const collectCleanupErrors = async (steps: CleanupStep[]): Promise<string[]> => {
  const errors: string[] = []
  for (const step of steps) {
    try {
      await step.run()
    } catch (error) {
      errors.push(`${step.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return errors
}

/** Save every failure report after resource cleanup, without replacing an error already escaping the runner. */
export const finalizeReport = async (
  path: string,
  report: { completed: boolean; failure: string | null; cleanupErrors: string[] },
  cleanup: CleanupStep[] = [],
) => {
  report.cleanupErrors.push(...(await collectCleanupErrors(cleanup)))
  report.completed &&= report.cleanupErrors.length === 0
  report.cleanupErrors.push(
    ...(await collectCleanupErrors([
      { name: 'report', run: () => writeFile(path, `${JSON.stringify(report, null, 2)}\n`) },
    ])),
  )
  if (!report.cleanupErrors.length) {
    return
  }
  report.completed = false
  const message = report.cleanupErrors.join('\n')
  if (report.failure !== null) {
    console.error(message)
    return
  }
  throw new Error(message)
}

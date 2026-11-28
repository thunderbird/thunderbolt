/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { rmSync } from 'node:fs'
import { notesPath } from './support/auth'
import { resultsPath } from './support/checks'

/**
 * Clear the previous run's output once per `playwright test` command. Doing it in a test hook would
 * re-run it whenever Playwright replaces the worker after a failed test, deleting earlier findings.
 */
export default () => {
  rmSync(resultsPath, { force: true })
  rmSync(notesPath, { force: true })
}

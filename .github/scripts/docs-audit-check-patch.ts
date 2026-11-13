/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Exits 1 when the docs audit's patch touches a file the audit may not edit. Runs before the patch is applied.
 *
 *   bun .github/scripts/docs-audit-check-patch.ts <patch>
 */
import { execFileSync } from 'node:child_process'
import { isInScope } from './docs-audit-select'

/** Paths in `git apply --numstat` output that fall outside the audit's scope. */
export const pathsOutsideScope = (numstat: string): string[] =>
  numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t')[2])
    .filter((path) => !isInScope(path))

const main = () => {
  const [patch] = process.argv.slice(2)
  const outside = pathsOutsideScope(execFileSync('git', ['apply', '--numstat', patch], { encoding: 'utf8' }))
  if (outside.length > 0) {
    console.error(`::error::The patch touches files outside the docs: ${outside.join(', ')}`)
    process.exit(1)
  }
}

if (import.meta.main) {
  main()
}

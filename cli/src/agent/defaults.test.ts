/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Parity checks between the README's hand-written provider tables and their
 * source-of-truth maps in `defaults.ts`. The tables are useful docs, but they
 * WILL drift silently without this: a provider added, removed, or re-defaulted
 * in code must fail here until the README rows match exactly.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { builtinProviderEnvVars, defaultModels } from './defaults.ts'

const readmePath = join(import.meta.dir, '..', '..', 'README.md')

/** Returns the README text between `heading` and the next markdown heading. */
const readmeSection = (markdown: string, heading: string): string => {
  const start = markdown.indexOf(heading)
  if (start === -1) throw new Error(`README heading not found: ${heading}`)
  const rest = markdown.slice(start + heading.length)
  const end = rest.indexOf('\n#')
  return end === -1 ? rest : rest.slice(0, end)
}

/** Parses a markdown table into trimmed cell texts, dropping header and separator rows. */
const tableRows = (section: string): string[][] =>
  section
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .slice(2)
    .map((row) =>
      row
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )

/** Extracts the backtick code-span values from one table cell. */
const codeSpans = (cell: string): string[] =>
  [...cell.matchAll(/`([^`]+)`/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))

describe('README provider tables mirror defaults.ts', () => {
  test('the Provider defaults table matches defaultModels exactly (no missing, no extra)', async () => {
    const readme = await readFile(readmePath, 'utf8')
    const rows = tableRows(readmeSection(readme, '### Provider defaults')).map(
      (cells) => [codeSpans(cells[0] ?? '')[0], codeSpans(cells[1] ?? '')[0]] as const,
    )

    expect(rows).toHaveLength(Object.keys(defaultModels).length)
    expect(Object.fromEntries(rows)).toEqual(defaultModels)
  })

  test('the Environment table lists every provider credential variable exactly (no missing, no extra)', async () => {
    const readme = await readFile(readmePath, 'utf8')
    const variableLists = tableRows(readmeSection(readme, '### Environment')).map((cells) => codeSpans(cells[0] ?? ''))
    // CLI-level variables (THUNDERBOLT_*) and NO_COLOR are documented in the same
    // table but are not provider credentials, so they are excluded from parity.
    const providerRows = variableLists.filter(
      (names) => !names.every((name) => name.startsWith('THUNDERBOLT_') || name === 'NO_COLOR'),
    )

    expect(providerRows).toEqual(Object.values(builtinProviderEnvVars).map((names) => [...names]))
  })
})

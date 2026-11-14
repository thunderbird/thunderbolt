/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')

type ComposeFile = { services: Record<string, { environment?: Record<string, unknown> | string[] }> }

/** Each service's NODE_ENV in a packaged Compose file, in either `environment` form. */
const nodeEnvsOf = (file: string) => {
  const compose = Bun.YAML.parse(readFileSync(join(root, file), 'utf8')) as ComposeFile
  return Object.values(compose.services).flatMap(({ environment }) => {
    if (Array.isArray(environment)) {
      return environment
        .filter((entry) => entry.startsWith('NODE_ENV='))
        .map((entry) => entry.slice('NODE_ENV='.length))
    }
    return environment && 'NODE_ENV' in environment ? [String(environment.NODE_ENV)] : []
  })
}

// NODE_ENV=test accepts a fixed sign-in code. Only local test stacks may set it.
test.each(['deploy/docker-compose.yml', 'deploy/nightly-compose.yml'])(
  '%s never runs a service in test mode',
  (file) => {
    expect(nodeEnvsOf(file)).not.toContain('test')
  },
)

test('the backend image leaves out the dev-only backend/scripts', () => {
  const dockerfile = readFileSync(join(import.meta.dir, 'backend.Dockerfile'), 'utf8')
  const sources = [...dockerfile.matchAll(/^COPY (?:--\S+\s+)*(.+)$/gm)].flatMap(([, instruction]) =>
    instruction!.trim().split(/\s+/).slice(0, -1),
  )

  expect(sources.length).toBeGreaterThan(0)
  expect(sources.filter((source) => source === 'backend' || source.startsWith('backend/scripts'))).toEqual([])
})

test('no backend source imports the dev-only backend/scripts', async () => {
  const backend = join(root, 'backend')
  const scripts = join(backend, 'scripts')
  const importers: string[] = []
  for await (const file of new Bun.Glob('src/**/*.{ts,tsx}').scan({ cwd: backend })) {
    const text = readFileSync(join(backend, file), 'utf8')
    const specifiers = [...text.matchAll(/(?:from|import\()\s*['"](\.[^'"]+)['"]/g)].map((match) => match[1]!)
    if (specifiers.some((specifier) => resolve(backend, dirname(file), specifier).startsWith(`${scripts}/`))) {
      importers.push(file)
    }
  }
  expect(importers).toEqual([])
})

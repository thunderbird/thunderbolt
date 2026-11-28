/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import * as pulumi from '@pulumi/pulumi'
import { createPerPrStack } from './per-pr-stack'
import type { SharedStackOutputs } from './shared'

type Created = { type: string; name: string; inputs: Record<string, unknown> }
const created: Created[] = []

/** Resources each test reads; `deploy` resolves once a stack has registered all of them. */
const required = ['be-task', 'database-url-version', 'powersync-storage-url-version', 'exec-secrets-policy']
const waiting = new Map<string, () => void>()

pulumi.runtime.setMocks(
  {
    newResource: ({ type, name, inputs }) => {
      created.push({ type, name, inputs })
      for (const [prefix, done] of waiting) {
        if (required.every((resource) => created.some((r) => r.name === `${prefix}-${resource}`))) {
          waiting.delete(prefix)
          done()
        }
      }
      return { id: name, state: { ...inputs, arn: `arn:${name}`, result: `random-${name}` } }
    },
    call: () => ({ region: 'us-east-1', secretString: 'x' }),
  },
  'per-pr-stack-test',
  'preview-pr-7',
  false,
)

/** Secret inputs arrive wrapped as `{ <sig>: …, value }`. */
const plain = (input: unknown) => (typeof input === 'object' && input && 'value' in input ? input.value : input)

const shared = new Proxy({} as SharedStackOutputs, {
  get: (_, key: string) => pulumi.output(key === 'postgresPort' ? 5432 : key),
})

/** Create a stack and resolve the inputs of every resource it registered. */
const deploy = async (prefix: string, forkPreview: boolean) => {
  const registered = new Promise<void>((done) => waiting.set(prefix, done))
  createPerPrStack({
    stackName: 'preview-pr-7',
    name: prefix,
    version: 'v',
    imagePrefix: 'ghcr.io/x',
    hostnames: { marketing: 'm', app: 'a', api: 'api', powersync: 'ps' },
    cloudflareZoneId: 'zone',
    cloudflareApiToken: pulumi.output('token'),
    shared,
    betterAuthSecret: pulumi.output('secret'),
    minAppVersion: '',
    cliDeviceRegistrationEnabled: false,
    confidentialApiKeysEnabled: false,
    forkPreview,
    email: { from: 'previews@example.com', resendApiKey: pulumi.output('resend-key') },
    branding: '',
  })
  await registered
  const mine = created.filter((resource) => resource.name.startsWith(`${prefix}-`))
  const byName = (name: string) => mine.find((resource) => resource.name === `${prefix}-${name}`)?.inputs
  const containers = JSON.parse(byName('be-task')?.containerDefinitions as string) as {
    name: string
    dependsOn?: { containerName: string; condition: string }[]
    environment?: { name: string; value: string }[]
    secrets: { name: string; valueFrom: string }[]
  }[]
  return { byName, containers }
}

test('only the db-init container gets the superuser password', async () => {
  const { byName, containers } = await deploy('same-repo', false)
  const [dbInit, backend] = containers

  expect(dbInit?.name).toBe('db-init')
  // The superuser connects into a database the role owns, so the role's search_path must not apply.
  expect(dbInit?.environment).toContainEqual({ name: 'PGOPTIONS', value: '-c search_path=pg_catalog,pg_temp' })
  expect(backend?.dependsOn).toEqual([{ containerName: 'db-init', condition: 'SUCCESS' }])
  for (const container of containers) {
    const usesAdmin = container.secrets.some((secret) => secret.valueFrom === 'postgresAdminPasswordSecretArn')
    expect(usesAdmin).toBe(container.name === 'db-init')
    expect(container.secrets.map((secret) => secret.name)).not.toContain('POSTGRES_ADMIN_URL')
  }

  for (const secret of ['database-url-version', 'powersync-storage-url-version']) {
    expect(plain(byName(secret)?.secretString)).toStartWith(
      'postgresql://preview_pr_7:random-same-repo-db-role-password@',
    )
  }
  expect(backend?.secrets.map((secret) => secret.name)).toEqual(
    expect.arrayContaining(['EXA_API_KEY', 'RESEND_API_KEY']),
  )
})

test('a fork preview gets no Exa or Tinfoil key', async () => {
  const { byName, containers } = await deploy('fork', true)
  const names = containers.flatMap((container) => container.secrets.map((secret) => secret.name))
  expect(names).not.toContain('EXA_API_KEY')
  expect(names).not.toContain('TINFOIL_API_KEY')
  expect(names).not.toContain('RESEND_API_KEY')
  const policy = byName('exec-secrets-policy')?.policy as string
  expect(policy).not.toContain('exaApiKeySecretArn')
  expect(policy).not.toContain('tinfoilApiKeySecretArn')
})

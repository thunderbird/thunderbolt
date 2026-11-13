/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Miniflare } from 'miniflare'

const hour = 3_600_000
const start = Date.now() + 24 * hour
let script: string
let runtime: Miniflare
let directory: string

beforeAll(async () => {
  const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, 'rate-limit.ts')], target: 'browser' })
  if (!bundle.success) throw new AggregateError(bundle.logs)
  // Test-only controls exercise expiry and alarms without waiting an hour or
  // adding clock/storage inspection endpoints to the deployed Worker.
  script = `${await bundle.outputs[0].text()}
    export class TestLimiter extends ContactRateLimiter {
      constructor(ctx) { super(ctx); this.ctx = ctx; }
      async fetch(request) {
        Date.now = () => Number(request.headers.get('Test-Time'));
        if (new URL(request.url).pathname === '/alarm') {
          await this.alarm();
          return Response.json({
            attempts: await this.ctx.storage.get('attempts') ?? [],
            alarm: await this.ctx.storage.getAlarm(),
          });
        }
        return super.fetch(request);
      }
    }
    export default { fetch() { return new Response(null, { status: 404 }); } };
  `
})

afterEach(async () => {
  await runtime?.dispose()
  if (directory) await rm(directory, { recursive: true, force: true })
})

/** Use real workerd SQLite storage, optionally across runtime restarts. */
const boot = () =>
  new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-07-30',
    durableObjects: { LIMITER: { className: 'TestLimiter', useSQLite: true } },
    durableObjectsPersist: directory,
  })

/** All simulated edge callers route to the same named object. */
const consume = async (ipHash: string, time = start, path = '/consume') => {
  const namespace = await runtime.getDurableObjectNamespace('LIMITER')
  return namespace.getByName('contact').fetch(`https://limiter${path}`, {
    headers: { 'X-Contact-IP-Hash': ipHash, 'Test-Time': String(time) },
  })
}

test('serializes concurrent attempts and preserves the per-IP limit across restarts', async () => {
  directory = await mkdtemp(join(tmpdir(), 'contact-quota-'))
  runtime = boot()
  const responses = await Promise.all(Array.from({ length: 12 }, () => consume('hashed-ip')))
  expect(responses.filter(({ status }) => status === 204)).toHaveLength(3)
  expect(responses.filter(({ status }) => status === 429)).toHaveLength(9)
  expect(responses.find(({ status }) => status === 429)?.headers.get('Retry-After')).toBe('3600')
  await runtime.dispose()
  runtime = boot()
  expect((await consume('hashed-ip', start + 1000)).status).toBe(429)
  expect((await consume('another-ip', start + 1000)).status).toBe(204)
  expect((await consume('hashed-ip', start + hour)).status).toBe(204)
}, 20_000)

test('caps concurrent submissions from different addresses at 30 worldwide', async () => {
  directory = await mkdtemp(join(tmpdir(), 'contact-quota-'))
  runtime = boot()
  const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => consume(`hash-${index}`)))
  expect(responses.filter(({ status }) => status === 204)).toHaveLength(30)
  expect(responses.filter(({ status }) => status === 429)).toHaveLength(20)
  const blocked = await consume('fresh-ip', start + hour - 1)
  expect(blocked.status).toBe(429)
  expect(blocked.headers.get('Retry-After')).toBe('1')
  expect((await consume('fresh-ip', start + hour)).status).toBe(204)
}, 20_000)

test('alarms expire individual records, reschedule, and erase idle state', async () => {
  directory = await mkdtemp(join(tmpdir(), 'contact-quota-'))
  runtime = boot()
  await consume('first')
  await consume('second', start + 10_000)
  const partial = await consume('', start + hour, '/alarm')
  expect(await partial.json()).toEqual({
    attempts: [{ ipHash: 'second', time: start + 10_000 }],
    alarm: start + hour + 10_000,
  })
  const expired = await consume('', start + hour + 10_000, '/alarm')
  expect(await expired.json()).toEqual({ attempts: [], alarm: null })
  const repeated = await consume('', start + hour + 10_000, '/alarm')
  expect(await repeated.json()).toEqual({ attempts: [], alarm: null })
}, 20_000)

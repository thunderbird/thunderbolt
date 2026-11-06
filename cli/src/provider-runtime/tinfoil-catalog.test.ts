/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, mock, test } from 'bun:test'
import { createTinfoilReasoningLoader } from './tinfoil-catalog.ts'
import { tinfoilModelsUrl } from '../../../shared/reasoning-effort-catalog.ts'

test('shares public discovery across bindings without sending account headers or model data', async () => {
  const request = mock(async () =>
    Response.json({
      data: [{ id: 'new-model', reasoning: true, supported_efforts: ['max', 'none', 'low', 'unknown'] }],
    }),
  )
  const load = createTinfoilReasoningLoader(request)
  const [known, missing] = await Promise.all([load('new-model'), load('missing')])
  expect(known).toEqual({ efforts: ['none', 'low', 'max'] })
  expect(missing).toEqual({ efforts: [] })
  expect(request).toHaveBeenCalledTimes(1)
  expect(request).toHaveBeenCalledWith(tinfoilModelsUrl, {
    redirect: 'error',
    signal: expect.any(AbortSignal),
  })
})

test.each([
  () => Promise.reject(new Error('Network unavailable')),
  async () => new Response('Unavailable', { status: 503 }),
  async () => new Response('invalid JSON'),
  async () => Response.json({ data: [{ id: 'm', supported_efforts: 'high' }] }),
])('rejects and retries failed discovery (%#)', async (fail) => {
  const request = mock(fail)
  const load = createTinfoilReasoningLoader(request)
  await expect(load('m')).rejects.toThrow()
  request.mockImplementation(async () =>
    Response.json({ data: [{ id: 'm', reasoning: true, supported_efforts: ['high'] }] }),
  )
  expect(await load('m')).toEqual({ efforts: ['high'] })
  expect(request).toHaveBeenCalledTimes(2)
})

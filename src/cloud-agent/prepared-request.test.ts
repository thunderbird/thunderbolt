/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { HttpError } from '@/lib/http'
import { createPreparedCloudRequest } from './prepared-request'

it('retries the same ID and ciphertext after response loss, ignoring changed draft inputs', async () => {
  const request = createPreparedCloudRequest<{ id: string; content: string }>()
  const prepared: string[] = []
  const submitted: string[] = []
  const prepare = (content: string) => {
    prepared.push(content)
    return { id: crypto.randomUUID(), content }
  }
  const submit = async (command: { id: string; content: string }) => {
    submitted.push(JSON.stringify(command))
    if (submitted.length === 1) {
      throw new TypeError('Response lost after commit')
    }
    return command.id
  }
  await expect(request.run('original ciphertext', prepare, submit)).rejects.toThrow('Response lost')
  expect(request.pending()).toBe(true)
  await request.run('different draft', prepare, submit)
  expect(prepared).toEqual(['original ciphertext'])
  expect(submitted[1]).toBe(submitted[0])
  expect(request.pending()).toBe(false)
})

it('lets a definite rejection be corrected but preserves an uncertain conflict for review', async () => {
  const request = createPreparedCloudRequest<string>()
  const prepare = (value: string) => value
  await expect(
    request.run('invalid', prepare, async () => {
      throw new Error('Storage limit', { cause: new HttpError(new Response(null, { status: 413 })) })
    }),
  ).rejects.toThrow('Storage limit')
  expect(request.pending()).toBe(false)
  await expect(
    request.run('changed', prepare, async () => {
      throw new HttpError(new Response(null, { status: 409 }))
    }),
  ).rejects.toThrow('409')
  expect(request.pending()).toBe(true)
})

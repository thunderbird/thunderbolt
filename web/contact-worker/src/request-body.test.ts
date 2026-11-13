/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, mock, test } from 'bun:test'
import { readContactBody } from './request-body'

const request = (body?: BodyInit) => new Request('https://example.com', { method: 'POST', body })

test('accepts exactly the byte limit', async () => {
  expect(await readContactBody(request(JSON.stringify('x'.repeat(32766))))).toEqual({
    ok: true,
    value: 'x'.repeat(32766),
  })
})
test('rejects oversized declared length without reading', async () => {
  const input = request('{}')
  input.headers.set('Content-Length', '32769')
  expect(await readContactBody(input)).toMatchObject({ ok: false, status: 413 })
  expect(input.bodyUsed).toBe(false)
})
test('counts UTF-8 bytes when declared length lies', async () => {
  const input = request(JSON.stringify('界'.repeat(11000)))
  input.headers.set('Content-Length', '2')
  expect(await readContactBody(input)).toMatchObject({ ok: false, status: 413 })
})
test('accumulates chunks and cancels oversized uploads', async () => {
  const cancel = mock(() => {})
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(20_000))
      controller.enqueue(new Uint8Array(20_000))
    },
    cancel,
  })
  expect(await readContactBody(request(stream))).toMatchObject({ ok: false, status: 413 })
  expect(cancel).toHaveBeenCalledTimes(1)
  const valid = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of ['{"email":', '"a@example.com"}']) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  expect(await readContactBody(request(valid))).toEqual({ ok: true, value: { email: 'a@example.com' } })
})
test.each([undefined, '', '{', new Uint8Array([0xff])])('rejects missing, malformed or non-UTF8 JSON', async (body) => {
  expect(await readContactBody(request(body))).toMatchObject({ ok: false, status: 400 })
})
test('reports broken streams and releases reader lock', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('Disconnected'))
    },
  })
  expect(await readContactBody(request(stream))).toMatchObject({ ok: false, status: 400 })
  expect(stream.locked).toBe(false)
})

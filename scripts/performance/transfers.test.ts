/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { createTransferRecorder } from './transfers'

test('retains redirect transfer bytes and assigns early/late extra-info to the correct hop', () => {
  const recorder = createTransferRecorder()
  recorder.request({ requestId: '1', request: { url: 'http://localhost/start' }, type: 'Document' })
  recorder.extraInfo({ requestId: '1', statusCode: 302 })
  recorder.request({
    requestId: '1',
    request: { url: 'http://localhost/app' },
    type: 'Document',
    redirectResponse: { status: 302, headers: {}, encodedDataLength: 120 },
    redirectHasExtraInfo: true,
  })
  recorder.response({
    requestId: '1',
    response: { status: 200, headers: { 'Content-Encoding': 'br' } },
    hasExtraInfo: true,
  })
  recorder.extraInfo({ requestId: '1', statusCode: 304 })
  recorder.finished({ requestId: '1', encodedDataLength: 90 })
  expect(recorder.snapshot()).toMatchObject([
    { url: 'http://localhost/start', status: 302, networkStatus: 302, networkEncodedBytes: 120 },
    { url: 'http://localhost/app', status: 200, networkStatus: 304, networkEncodedBytes: 90, contentEncoding: 'br' },
  ])
})

test('a cached hop without extra-info does not steal a later network status; snapshots stop changing', () => {
  const recorder = createTransferRecorder()
  recorder.request({ requestId: '1', request: { url: 'http://localhost/cached' } })
  recorder.cached({ requestId: '1' })
  recorder.request({
    requestId: '1',
    request: { url: 'http://localhost/final' },
    redirectResponse: { status: 301, headers: {}, encodedDataLength: 0 },
    redirectHasExtraInfo: false,
  })
  recorder.extraInfo({ requestId: '1', statusCode: 200 })
  recorder.response({ requestId: '1', response: { status: 200, headers: {} }, hasExtraInfo: true })
  const snapshot = recorder.snapshot()
  recorder.failed({ requestId: '1', errorText: 'aborted' })
  expect(snapshot[0]).toMatchObject({ fromCache: true, networkEncodedBytes: 0 })
  expect(snapshot[0]?.networkStatus).toBeUndefined()
  expect(snapshot[1]?.networkStatus).toBe(200)
  expect(snapshot[1]?.networkEncodedBytes).toBeUndefined()
  expect(snapshot[1]?.failure).toBeUndefined()
  expect(recorder.snapshot()[1]?.failure).toBe('aborted')
})

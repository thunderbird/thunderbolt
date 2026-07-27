/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { encodeWavUpload } from './audio-engine'

describe('encodeWavUpload', () => {
  test('emits an explicit boundary that matches the Content-Type header', async () => {
    const wav = new Uint8Array([1, 2, 3, 4]).buffer
    const { body, contentType } = encodeWavUpload(wav, 'whisper-large-v3-turbo')

    const boundary = contentType.match(/boundary=(.+)$/)?.[1]
    expect(boundary).toBeTruthy()
    expect(contentType.startsWith('multipart/form-data; boundary=')).toBe(true)
    // The Blob's own type must also carry the boundary, so it stays consistent
    // even if a caller forwards the Blob without our explicit header.
    expect(body.type).toBe(contentType)

    const text = new TextDecoder().decode(await body.arrayBuffer())
    // The boundary in the body must match the one advertised in the header — the
    // whole point of the fix (FormData's implicit boundary didn't survive).
    expect(text).toContain(`--${boundary}\r\n`)
    expect(text).toContain(`\r\n--${boundary}--\r\n`)
  })

  test('includes both required form fields with the model value', async () => {
    const wav = new Uint8Array([0]).buffer
    const { body } = encodeWavUpload(wav, 'my-model')
    const text = new TextDecoder().decode(await body.arrayBuffer())

    expect(text).toContain('Content-Disposition: form-data; name="model"')
    expect(text).toContain('my-model')
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="utterance.wav"')
    expect(text).toContain('Content-Type: audio/wav')
  })

  test('embeds the wav bytes verbatim between the part headers', async () => {
    const wav = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer
    const { body } = encodeWavUpload(wav, 'm')
    // The 4 wav bytes appear contiguously somewhere in the multipart body.
    const hay = Array.from(new Uint8Array(await body.arrayBuffer()))
    const needle = [0xde, 0xad, 0xbe, 0xef]
    const found = hay.some((_, i) => needle.every((b, j) => hay[i + j] === b))
    expect(found).toBe(true)
  })
})

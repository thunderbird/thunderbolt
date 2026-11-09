/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { type AudioTransport, createAudioEngine } from './audio-engine'

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const item of iterable) {
    out.push(item)
  }
  return out
}

describe('createAudioEngine transcription', () => {
  it('asks for greedy decoding', async () => {
    const forms: FormData[] = []
    const transport: AudioTransport = async (_path, body) => {
      forms.push(body as FormData)
      return Response.json({ text: ' hello ' })
    }
    const engine = createAudioEngine({ id: 'test', transport, sttModel: 'stt', ttsModel: 'tts', ttsVoice: 'voice' })
    const audio = (async function* () {
      yield new Float32Array(160)
    })()
    const transcripts = await collect(engine.transcribe(audio))
    expect(forms[0].get('model')).toBe('stt')
    expect(forms[0].get('temperature')).toBe('0')
    expect(transcripts).toEqual([{ text: 'hello', isFinal: true }])
  })
})

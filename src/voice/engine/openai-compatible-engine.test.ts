/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { classifyModels } from './openai-compatible-engine'

describe('classifyModels', () => {
  test('splits STT and TTS by task and maps embedded voices', () => {
    const result = classifyModels([
      { id: 'Systran/faster-whisper-small', task: 'automatic-speech-recognition' },
      {
        id: 'speaches-ai/Kokoro-82M-v1.0-ONNX',
        task: 'text-to-speech',
        voices: [{ id: 'af_heart' }, { id: 'am_adam' }],
      },
    ])
    expect(result.stt).toEqual(['Systran/faster-whisper-small'])
    expect(result.tts).toEqual([{ id: 'speaches-ai/Kokoro-82M-v1.0-ONNX', voices: ['af_heart', 'am_adam'] }])
  })

  test('TTS model with no voices yields an empty voice list', () => {
    const result = classifyModels([{ id: 'kokoro', task: 'text-to-speech' }])
    expect(result.tts).toEqual([{ id: 'kokoro', voices: [] }])
  })

  test('untagged models (generic servers) are offered under both STT and TTS', () => {
    const result = classifyModels([{ id: 'whisper-1' }, { id: 'tts-1' }])
    expect(result.stt).toEqual(['whisper-1', 'tts-1'])
    expect(result.tts).toEqual([
      { id: 'whisper-1', voices: [] },
      { id: 'tts-1', voices: [] },
    ])
  })

  test('empty input yields empty lists', () => {
    expect(classifyModels([])).toEqual({ stt: [], tts: [] })
  })
})

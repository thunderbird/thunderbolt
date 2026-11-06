/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { MediaDevicesUnavailableError, toVoiceErrorMessage } from './voice-error'

describe('toVoiceErrorMessage', () => {
  test('explains a blocked microphone', () => {
    expect(toVoiceErrorMessage(new DOMException('denied', 'NotAllowedError'))).toContain('Microphone access is blocked')
    expect(toVoiceErrorMessage(new DOMException('insecure', 'SecurityError'))).toContain('Microphone access is blocked')
  })

  test('explains a missing microphone', () => {
    expect(toVoiceErrorMessage(new DOMException('none', 'NotFoundError'))).toContain('No microphone found')
  })

  test('explains a microphone in use', () => {
    expect(toVoiceErrorMessage(new DOMException('busy', 'NotReadableError'))).toContain('being used by another app')
  })

  test('explains an unavailable media API (insecure webview context)', () => {
    const message = toVoiceErrorMessage(new MediaDevicesUnavailableError())
    expect(message).toContain('isn’t available in this window')
    expect(message).toContain('secure context')
  })

  test('passes other errors through verbatim (keeps provider bodies debuggable)', () => {
    expect(toVoiceErrorMessage(new Error('TTS failed: 400 {"error":"bad voice"}'))).toBe(
      'Error: TTS failed: 400 {"error":"bad voice"}',
    )
  })
})

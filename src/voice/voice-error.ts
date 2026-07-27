/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Map a voice-session failure to a human message (THU-689).
 *
 * `getUserMedia` rejects with `DOMException`s whose `.name` says what went wrong
 * (blocked, no device, in use). We turn those into a clear, actionable line
 * instead of a raw "NotAllowedError". Anything else (STT/TTS/network) is passed
 * through verbatim so provider error bodies stay debuggable.
 */
export const toVoiceErrorMessage = (error: unknown): string => {
  const name = error instanceof DOMException ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access is blocked. Allow microphone access in your browser or system settings, then try again.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found. Connect a microphone and try again.'
    case 'NotReadableError':
      return 'Your microphone is being used by another app. Close it and try again.'
    default:
      return String(error)
  }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The webview doesn't expose the media-capture API at all — `navigator.mediaDevices`
 * is undefined, so we can't even call `getUserMedia`. Distinct from a getUserMedia
 * rejection: WKWebView only exposes `mediaDevices` in a secure context (https or a
 * bundle-loaded app), so a Tauri *dev* build served over `http://localhost` hits
 * this, while a packaged build does not.
 */
export class MediaDevicesUnavailableError extends Error {
  constructor() {
    super('navigator.mediaDevices is unavailable in this context')
    this.name = 'MediaDevicesUnavailableError'
  }
}

/**
 * Map a voice-session failure to a human message (THU-689).
 *
 * `getUserMedia` rejects with `DOMException`s whose `.name` says what went wrong
 * (blocked, no device, in use). We turn those into a clear, actionable line
 * instead of a raw "NotAllowedError". Anything else (STT/TTS/network) is passed
 * through verbatim so provider error bodies stay debuggable.
 */
export const toVoiceErrorMessage = (error: unknown): string => {
  if (error instanceof MediaDevicesUnavailableError) {
    return 'Microphone isn’t available in this window. Voice mode needs a secure context — try again over https, or use the packaged desktop app rather than the dev server.'
  }
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

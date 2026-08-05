/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Mic capture worklet (THU-684). The AudioContext runs at the mic's native rate
// (browsers won't connect a MediaStreamSource across sample rates), so this
// linearly resamples to 16 kHz — what the energy VAD and STT expect — and emits
// fixed 512-sample frames. Plain JS in /public so `audioWorklet.addModule` loads
// it with the correct MIME (no bundler transform).
const TARGET_RATE = 16000
const FRAME_SAMPLES = 512

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // Input samples per output sample, e.g. 3.0 at a 48 kHz context.
    this._ratio = sampleRate / TARGET_RATE
    this._frame = new Float32Array(FRAME_SAMPLES)
    this._fill = 0
    this._pending = new Float32Array(0)
    this._pos = 0 // fractional read position within _pending
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true

    const merged = new Float32Array(this._pending.length + channel.length)
    merged.set(this._pending, 0)
    merged.set(channel, this._pending.length)
    this._pending = merged

    while (this._pos + 1 < this._pending.length) {
      const i = Math.floor(this._pos)
      const frac = this._pos - i
      this._frame[this._fill++] = this._pending[i] * (1 - frac) + this._pending[i + 1] * frac
      if (this._fill === FRAME_SAMPLES) {
        this.port.postMessage(this._frame.slice())
        this._fill = 0
      }
      this._pos += this._ratio
    }

    const consumed = Math.floor(this._pos)
    if (consumed > 0) {
      this._pending = this._pending.slice(consumed)
      this._pos -= consumed
    }
    return true
  }
}

registerProcessor('capture-processor', CaptureProcessor)

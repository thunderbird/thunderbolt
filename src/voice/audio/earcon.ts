/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Voice-mode earcons (THU-856).
 *
 * The visual surface can't answer the two questions that matter most in a voice
 * conversation, because answering them requires the user to be looking at it —
 * and the whole point of speaking is that they aren't. So two short tones:
 *
 * - **listening** — a rising pair the moment the mic opens. Before this, the
 *   waveform sits at a flat resting line whether we're still starting up or
 *   already listening, so there was nothing to tell the user when to begin.
 * - **captured** — the same interval falling, quieter, when an utterance is
 *   handed off. Deliberately the mirror image: one pair to learn, not two
 *   sounds to memorise, and the direction carries the meaning (open / closed).
 *
 * Synthesised rather than shipped as assets — two sine tones cost nothing to
 * bundle and nothing to fetch, and there is no artwork to keep in sync.
 *
 * **They cannot trigger barge-in.** Each is shorter than the sustained speech
 * the endpointer requires (`minSpeechFrames` × 32 ms = 256 ms), and they play
 * through `destination`, so the browser's echo canceller sees them as playout
 * and not as something the user said. `earcon.test.ts` pins the first of those.
 */

/** One note: a frequency, when it starts relative to the earcon, how long it lasts. */
export type Tone = { hz: number; startMs: number; durationMs: number }

// A perfect fourth (E5 → A5). Bright and open going up, settled coming down.
const e5 = 659.25
const a5 = 880

/** Rising: the mic is open, go ahead. */
export const listeningTones: readonly Tone[] = [
  { hz: e5, startMs: 0, durationMs: 90 },
  { hz: a5, startMs: 60, durationMs: 110 },
]

/** Falling: heard you, working on it. */
export const capturedTones: readonly Tone[] = [
  { hz: a5, startMs: 0, durationMs: 70 },
  { hz: e5, startMs: 50, durationMs: 90 },
]

// Quiet on purpose. The listening tone plays directly into the pause where the
// user is about to speak, and the captured tone plays over their own trailing
// breath — either one at notification volume would be startling.
export const listeningPeak = 0.14
/** Lower still: it acknowledges rather than invites, and it fires every turn. */
export const capturedPeak = 0.08

const attackSeconds = 0.008
// exponentialRampToValueAtTime cannot reach zero; this is inaudible.
const silence = 0.0001

/** How long an earcon lasts end to end, including the overlap between notes. */
export const earconDurationMs = (tones: readonly Tone[]): number =>
  Math.max(...tones.map((tone) => tone.startMs + tone.durationMs))

export type Earcons = {
  /** The mic is open. Played once, when the session becomes ready. */
  listening: () => void
  /** An utterance committed. Played as it is handed off for transcription. */
  captured: () => void
}

const play = (ctx: AudioContext, tones: readonly Tone[], peak: number): void => {
  // stop() closes the playback context, and an utterance already in flight can
  // reach here after that — building nodes on a closed context throws.
  if (ctx.state === 'closed') {
    return
  }
  void ctx.resume() // no-op once running; needed after the user-gesture start
  const begin = ctx.currentTime
  for (const tone of tones) {
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = tone.hz

    const at = begin + tone.startMs / 1000
    const until = at + tone.durationMs / 1000
    // Enveloped rather than switched: starting or stopping a sine at full
    // amplitude puts a step in the waveform, which is audible as a click.
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(peak, at + attackSeconds)
    gain.gain.exponentialRampToValueAtTime(silence, until)

    oscillator.connect(gain)
    // Straight to destination, bypassing the playback queue: routing through its
    // analyser would make the waveform lurch on our own chime, and adding these
    // to its active set would have the session believe the assistant is still
    // speaking and hold off returning to 'listening'.
    gain.connect(ctx.destination)
    oscillator.start(at)
    oscillator.stop(until)
    // A stopped oscillator is collectable, but its gain node stays wired to
    // destination — and the captured cue fires every turn, so a long session
    // would accumulate one per turn for the life of the context.
    oscillator.onended = () => gain.disconnect()
  }
}

export const createEarcons = (ctx: AudioContext): Earcons => ({
  listening: () => play(ctx, listeningTones, listeningPeak),
  captured: () => play(ctx, capturedTones, capturedPeak),
})

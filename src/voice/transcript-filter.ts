/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Whisper silence-hallucination filter (THU-688).
 *
 * When Whisper is handed near-silent or noise-only audio (an over-eager VAD
 * endpointing on background noise), it doesn't return empty — it emits its most
 * common training-caption phrases: "Thank you", "Thanks for watching", "Bye".
 * Those become phantom voice turns the user never spoke. This flags a transcript
 * that is nothing but such filler so the session can drop it instead of replying.
 *
 * Deliberately conservative: only whole-utterance matches of unmistakable
 * video-caption phrases (plus the bare "you" Whisper loves to emit on silence)
 * are dropped. Bare conversational courtesies a user actually says to the
 * assistant — "thank you", "thanks", "bye", "goodbye" — are intentionally NOT
 * here: dropping a real sign-off (assistant goes silent) is worse than very
 * occasionally replying to a noise-triggered "thank you".
 */

const noisePhrases = [
  'thanks for watching',
  'thank you for watching',
  'thank you for your watching',
  'please subscribe',
  'like and subscribe',
  'see you next time',
  'see you in the next video',
  'you',
]

// Longest first, so "thank you for watching" is removed before "thank you"
// leaves an orphaned "for watching".
const noisePhrasesByLength = [...noisePhrases].sort((a, b) => b.length - a.length)

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * True when a transcript is empty or consists solely of Whisper caption-filler
 * (possibly a few concatenated, e.g. "Thank you. Bye.") — i.e. almost certainly
 * a silence hallucination rather than something the user said.
 */
export const isHallucinatedTranscript = (text: string): boolean => {
  const normalized = normalize(text)
  if (!normalized) {
    return true
  }
  let rest = ` ${normalized} `
  let prev = ''
  while (rest !== prev) {
    prev = rest
    for (const phrase of noisePhrasesByLength) {
      rest = rest.split(` ${phrase} `).join(' ')
    }
  }
  return rest.trim().length === 0
}

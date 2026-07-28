/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { isHallucinatedTranscript } from './transcript-filter'

describe('isHallucinatedTranscript', () => {
  test('flags empty / whitespace / punctuation-only transcripts', () => {
    expect(isHallucinatedTranscript('')).toBe(true)
    expect(isHallucinatedTranscript('   ')).toBe(true)
    expect(isHallucinatedTranscript('...')).toBe(true)
  })

  test('flags unmistakable video-caption hallucination phrases', () => {
    expect(isHallucinatedTranscript('Thanks for watching!')).toBe(true)
    expect(isHallucinatedTranscript('Please subscribe.')).toBe(true)
    expect(isHallucinatedTranscript('See you next time.')).toBe(true)
    expect(isHallucinatedTranscript('you')).toBe(true) // bare "you" — classic silence emit
  })

  test('flags several caption phrases concatenated', () => {
    expect(isHallucinatedTranscript('Thanks for watching. Please subscribe.')).toBe(true)
    expect(isHallucinatedTranscript('Thank you for watching. See you next time.')).toBe(true)
  })

  test('keeps genuine conversational courtesies the user actually says', () => {
    // These are real sign-offs to the assistant — dropping them (silent no-reply)
    // is worse than occasionally answering a noise-triggered "thank you".
    expect(isHallucinatedTranscript('thank you')).toBe(false)
    expect(isHallucinatedTranscript('thanks')).toBe(false)
    expect(isHallucinatedTranscript('bye')).toBe(false)
    expect(isHallucinatedTranscript('goodbye')).toBe(false)
  })

  test('keeps genuine short utterances', () => {
    expect(isHallucinatedTranscript('yes')).toBe(false)
    expect(isHallucinatedTranscript('stop')).toBe(false)
    expect(isHallucinatedTranscript('what is the weather in Seattle')).toBe(false)
  })

  test('keeps utterances that merely contain a filler word', () => {
    expect(isHallucinatedTranscript('thank you for the summary, can you expand it')).toBe(false)
  })
})

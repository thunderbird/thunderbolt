/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, test } from 'bun:test'
import { isVoiceModeActive, setVoiceModeActive, voiceModeSystemNote } from './voice-mode'

describe('voice-mode signal', () => {
  afterEach(() => setVoiceModeActive(false)) // never leak active state across tests

  test('toggles the active flag', () => {
    expect(isVoiceModeActive()).toBe(false)
    setVoiceModeActive(true)
    expect(isVoiceModeActive()).toBe(true)
    setVoiceModeActive(false)
    expect(isVoiceModeActive()).toBe(false)
  })

  test('self-context covers the constraints the model gets wrong without it', () => {
    expect(voiceModeSystemNote).toContain('voice mode')
    expect(voiceModeSystemNote.toLowerCase()).toContain('short') // brevity
    expect(voiceModeSystemNote.toLowerCase()).toContain('do not search the web') // anti-hallucination
    expect(voiceModeSystemNote.toLowerCase()).toContain('fixed') // voice can't change
  })
})

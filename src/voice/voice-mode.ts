/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Voice-mode signal + self-context (THU-683).
 *
 * Voice turns reuse the normal chat send path, so the prompt builder can't tell a
 * spoken turn from a typed one. This module carries a process-wide "voice active"
 * flag that `aiFetchStreamingResponse` reads to inject {@link voiceModeSystemNote}
 * as a system message *only* during voice — giving the model the self-knowledge it
 * needs (it's speaking aloud, its voice is fixed, keep replies brief) without
 * cluttering text chats.
 *
 * Known limitation (intentional): the flag is tab-global, and `aiFetchStreamingResponse`
 * is the shared send path for *all* AI calls. So a non-voice call that happens to
 * fire during a live voice session — e.g. title generation — would also get the
 * note. In practice the composer is inert during voice so interactive overlap is
 * rare and the impact is cosmetic, so we keep the singleton for now. If that ever
 * matters, the fix is to scope it per-request: thread a `voiceMode` flag on the
 * voice send (`chat.sendMessage(..., { body: { voiceMode: true } })`) through to
 * the prompt builder instead of reading a global.
 */
let voiceModeActive = false

export const setVoiceModeActive = (active: boolean): void => {
  voiceModeActive = active
}

export const isVoiceModeActive = (): boolean => voiceModeActive

/**
 * System message injected on voice turns only. Kept tight (it's added every voice
 * turn) and focused on what the model gets wrong without it — notably answering
 * questions about itself: a model with no voice context web-searches its own
 * identity instead of just answering.
 */
export const voiceModeSystemNote =
  'You are in voice mode: the user is speaking to you and your replies are read aloud by text-to-speech. ' +
  "Keep replies short and conversational — usually a sentence or two — since they're heard, not read; " +
  'avoid markdown, bullet lists, code, and URLs, and phrase things in plain spoken language. ' +
  'If asked about your voice or what you can do in voice mode, answer plainly from this context — do NOT ' +
  'search the web for your own identity or capabilities. Your speaking voice is fixed and cannot be changed ' +
  'during a conversation. The user can interrupt you at any time simply by speaking.'

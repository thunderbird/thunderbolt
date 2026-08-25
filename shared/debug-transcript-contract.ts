/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const debugTranscriptsDisabledCode = 'DEBUG_TRANSCRIPTS_DISABLED'
export const debugTranscriptTooLargeCode = 'DEBUG_TRANSCRIPT_TOO_LARGE'
export const anonymousTranscriptForbiddenCode = 'ANONYMOUS_TRANSCRIPT_FORBIDDEN'

export type DebugTranscriptErrorCode =
  | typeof debugTranscriptsDisabledCode
  | typeof debugTranscriptTooLargeCode
  | typeof anonymousTranscriptForbiddenCode

export const debugTranscriptNoteMaxLength = 2000
export const debugTranscriptServerPayloadMaxBytes = 2 * 1024 * 1024
// Client trimming leaves headroom below the server's hard payload limit.
export const debugTranscriptClientPayloadTargetBytes = 1_500_000

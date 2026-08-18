/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/lib/http'
import { sanitizeDebugTranscriptText } from './sanitizer'
import type { DebugTranscriptPayloadV1 } from './types'

export type SubmitDebugTranscriptInput = {
  threadId: string
  payload: DebugTranscriptPayloadV1
  userNote?: string
  clientVersion?: string
}

export type SubmitDebugTranscriptResult = {
  id: string
}

/** Submit a sanitized debug transcript to the authenticated app backend. */
export const submitDebugTranscript = (
  httpClient: HttpClient,
  { threadId, payload, userNote, clientVersion }: SubmitDebugTranscriptInput,
): Promise<SubmitDebugTranscriptResult> => {
  const sanitizedUserNote = sanitizeDebugTranscriptText(userNote?.trim() ?? '') || undefined
  return httpClient
    .post('debug-transcripts', {
      json: {
        threadId,
        schemaVersion: payload.schemaVersion,
        payload,
        userNote: sanitizedUserNote,
        clientVersion,
      },
    })
    .json<SubmitDebugTranscriptResult>()
}

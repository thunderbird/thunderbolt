/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { debugTranscriptNoteMaxLength } from '@shared/debug-transcript-contract'
import type { HttpClient } from '@/lib/http'
import { sanitizeDebugTranscriptText } from './sanitizer'
import type { DebugTranscriptPayloadV1 } from './types'

export type SubmitDebugTranscriptInput = {
  threadId: string
  payload: DebugTranscriptPayloadV1
  userNote?: string
  clientVersion?: string
  signal?: AbortSignal
  timeout?: number
}

export type SubmitDebugTranscriptResult = {
  id: string
}

/** Build the preview/upload body, sanitizing the complete note before enforcing its length limit. */
export const buildDebugTranscriptRequest = ({
  threadId,
  payload,
  userNote,
  clientVersion,
}: Omit<SubmitDebugTranscriptInput, 'signal' | 'timeout'>) => ({
  threadId,
  schemaVersion: payload.schemaVersion,
  payload,
  userNote:
    sanitizeDebugTranscriptText(userNote?.trim() ?? '')
      .slice(0, debugTranscriptNoteMaxLength)
      .trimEnd() || undefined,
  clientVersion,
})

/** Submit a sanitized debug transcript to the authenticated app backend. */
export const submitDebugTranscript = (
  httpClient: HttpClient,
  { signal, timeout, ...input }: SubmitDebugTranscriptInput,
): Promise<SubmitDebugTranscriptResult> =>
  httpClient
    .post('debug-transcripts', {
      json: buildDebugTranscriptRequest(input),
      signal,
      timeout,
    })
    .json<SubmitDebugTranscriptResult>()

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'
import { z } from 'zod'
import type { DebugTranscriptToolCallV1, DebugTranscriptToolStatus, JsonValue } from './types'

const durationSchema = z.number().nonnegative()
const maxToolValueSerializedLength = 50 * 1024
type StateFromPart<Part> = Part extends { state: infer State } ? State : never
type ToolPartState = StateFromPart<ThunderboltUIMessage['parts'][number]> | undefined

const boundToolValue = (value: JsonValue): JsonValue =>
  JSON.stringify(value)!.length > maxToolValueSerializedLength ? '[value too large]' : value

const toolNameFromPart = (part: ThunderboltUIMessage['parts'][number]): string => {
  if (part.type === 'dynamic-tool') {
    return part.toolName
  }
  return part.type.replace(/^tool-/, '')
}

/** Classify persisted tool states without treating unfinished calls as successful. */
const toolStatusFromState = (state: ToolPartState): DebugTranscriptToolStatus => {
  switch (state) {
    case 'input-streaming':
    case 'input-available':
    case 'approval-requested':
    case 'approval-responded':
      return 'incomplete'
    case 'output-error':
    case 'output-denied':
      return 'error'
    case 'output-available':
    case undefined:
      return 'ok'
  }
}

/** Normalize persisted AI SDK tool parts for transcript reconstruction. */
export const extractDebugTranscriptToolCalls = (message: ThunderboltUIMessage): DebugTranscriptToolCallV1[] =>
  message.parts.flatMap((part): DebugTranscriptToolCallV1[] => {
    if (!('toolCallId' in part)) {
      return []
    }
    const argumentsValue = 'input' in part && part.input !== undefined ? (part.input as JsonValue) : null
    const state = 'state' in part ? part.state : undefined
    const resultValue =
      'output' in part && part.output !== undefined
        ? (part.output as JsonValue)
        : 'errorText' in part && part.errorText !== undefined
          ? String(part.errorText)
          : null
    const duration = durationSchema.safeParse(message.metadata?.reasoningTime?.[part.toolCallId])
    return [
      {
        toolCallId: part.toolCallId,
        name: toolNameFromPart(part),
        arguments: boundToolValue(argumentsValue),
        result: boundToolValue(resultValue),
        status: toolStatusFromState(state),
        durationMs: duration.success ? duration.data : null,
      },
    ]
  })

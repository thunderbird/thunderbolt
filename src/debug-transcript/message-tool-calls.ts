/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'
import { z } from 'zod'
import type { DebugTranscriptToolCallV1, JsonValue } from './types'

const durationSchema = z.number().nonnegative()
const maxToolValueSerializedLength = 50 * 1024

const boundToolValue = (value: JsonValue): JsonValue =>
  JSON.stringify(value)!.length > maxToolValueSerializedLength ? '[value too large]' : value

const toolNameFromPart = (part: ThunderboltUIMessage['parts'][number]): string => {
  if (part.type === 'dynamic-tool') {
    return part.toolName
  }
  return part.type.replace(/^tool-/, '')
}

/** Normalize persisted AI SDK tool parts for transcript reconstruction. */
export const extractDebugTranscriptToolCalls = (message: ThunderboltUIMessage): DebugTranscriptToolCallV1[] =>
  message.parts.flatMap((part): DebugTranscriptToolCallV1[] => {
    if (!('toolCallId' in part)) {
      return []
    }
    const argumentsValue = 'input' in part && part.input !== undefined ? (part.input as JsonValue) : null
    const isError = 'state' in part && part.state === 'output-error'
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
        status: isError ? 'error' : 'ok',
        durationMs: duration.success ? duration.data : null,
      },
    ]
  })

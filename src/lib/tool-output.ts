/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import { z } from 'zod'

const envelopeSchema = z.object({
  details: z.unknown().optional(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).optional(),
})

/**
 * Read a finished tool call's output with `schema`: `undefined` before it finishes or when it does not match.
 *
 * Parsed rather than cast, and tolerant of the MCP-style `{ content: [{ type: 'text', text }], details }`
 * envelope. The Pi harness returns every app tool's result in that envelope, with the raw output in
 * `details`, and so does a remote ACP agent, whose pi `AgentToolResult` the ACP layer forwards verbatim
 * as `rawOutput` (`cli/src/acp/harness-to-acp.ts`). Some providers also wrap a tool result this way. A bare
 * cast cannot fail, so a wrapped result once sailed through as an object whose fields were `undefined`.
 * This runs during render, so nothing here may throw.
 */
export const parseToolOutput = <T>(schema: z.ZodType<T>, part: ToolUIPart | DynamicToolUIPart): T | undefined => {
  const output = part.output
  if (output === undefined || output === null) {
    return undefined
  }

  const direct = schema.safeParse(output)
  if (direct.success) {
    return direct.data
  }

  const envelope = envelopeSchema.safeParse(output)
  if (!envelope.success) {
    return undefined
  }

  const fromDetails = schema.safeParse(envelope.data.details)
  if (fromDetails.success) {
    return fromDetails.data
  }

  // Last resort: the same object re-serialised into the text block.
  const text = envelope.data.content?.find((entry) => entry.type === 'text')?.text
  if (text === undefined) {
    return undefined
  }
  const parsedText = z
    .string()
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown
      } catch {
        ctx.addIssue({ code: 'custom', message: 'not JSON' })
        return z.NEVER
      }
    })
    .pipe(schema)
    .safeParse(text)
  return parsedText.success ? parsedText.data : undefined
}

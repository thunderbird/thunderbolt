/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { extractDebugTranscriptToolCalls } from './message-tool-calls'

test('retains the raw arguments of an interrupted script', () => {
  const rawInput = { script: 'unfinished' }
  expect(
    extractDebugTranscriptToolCalls({
      role: 'assistant',
      id: 'a',
      parts: [
        {
          type: 'tool-run_office_script',
          state: 'output-error',
          toolCallId: 'office',
          input: undefined,
          rawInput,
          errorText: 'AbortError',
        },
      ],
    }),
  ).toMatchObject([{ arguments: rawInput, status: 'error' }])
})

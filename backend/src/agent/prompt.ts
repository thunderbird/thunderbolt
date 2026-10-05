/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const filePrefix = 'file:'

/**
 * Resolve the deployment's `AGENT_SYSTEM_PROMPT`. A `file:<path>` value is read from disk, since multi-line
 * prompts are awkward in environment variables; any other value is the prompt itself.
 */
export const resolveAgentSystemPrompt = async (value: string): Promise<string> =>
  value.startsWith(filePrefix) ? Bun.file(value.slice(filePrefix.length)).text() : value

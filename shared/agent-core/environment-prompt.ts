/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AgentHarnessOptions } from '@earendil-works/pi-agent-core'

/**
 * Browser-only execution constraints for the Pi app harness. This stays outside
 * the base app prompt so legacy and CLI model paths do not receive it.
 */
export const APP_HARNESS_ENVIRONMENT_PROMPT = `# Environment
The \`bash\`, \`read\`, \`write\`, and \`edit\` tools operate in an isolated virtual workspace private to this conversation. \`bash\` is a simulated shell with no network access; \`curl\` and \`wget\` are unavailable. Never use \`bash\` to reach the web.
Available inside \`bash\`: coreutils, \`grep\`, \`find\`, \`sed\`, \`awk\`, \`rg\`, \`jq\`, \`sqlite3\`, and \`tar\`. Use it for computation and data processing.
For anything on the web, use the \`search\` and \`fetch_content\` tools.
Workspace files are not visible to the user. Never tell the user output was saved to a file. Deliver final content directly in the chat response, or use the \`render_html\` tool when appropriate.`

/**
 * Appends browser execution constraints whenever Pi resolves the system prompt,
 * preserving per-send updates from the caller's mutable prompt source.
 *
 * @param systemPrompt - caller-owned system prompt source
 * @returns a lazy system prompt source containing app environment constraints
 */
export const withAppEnvironmentPrompt = (
  systemPrompt: AgentHarnessOptions['systemPrompt'],
): AgentHarnessOptions['systemPrompt'] => {
  if (typeof systemPrompt !== 'function') {
    return systemPrompt ? `${systemPrompt}\n\n${APP_HARNESS_ENVIRONMENT_PROMPT}` : APP_HARNESS_ENVIRONMENT_PROMPT
  }

  return async (context) => `${await systemPrompt(context)}\n\n${APP_HARNESS_ENVIRONMENT_PROMPT}`
}

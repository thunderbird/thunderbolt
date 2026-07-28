/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Default web behavior for built-in models. Interpolated into the base
 * prompt's `# Tools` section only when the `search`/`fetch_content` tools are
 * present in the toolset, so a session without them is never told it has them.
 */
export const webToolsPrompt = `Web lookups use the \`search\` and \`fetch_content\` tools.
Quick questions: run 1–3 searches, fetch the most promising pages, and answer from them.
Deep dives, research requests, or comprehensive reports: go beyond the default tool budget—break the question into sub-questions, search each from multiple angles, fetch several pages per sub-question, and synthesize the findings.`

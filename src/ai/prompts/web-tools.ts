/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Default web behavior for built-in models. Interpolated into the base
 * prompt's `# Tools` section only when the `search`/`fetch_content` tools are
 * present in the toolset, so a session without them is never told it has them.
 */
export const webToolsPrompt = `Web lookups use the \`search\` and \`fetch_content\` tools.
Quick questions: run at most one search and answer from its snippets. Fetch a page only when the snippets are insufficient.
Deep dives, research requests, or comprehensive reports: break the question into sub-questions, search each from multiple angles, fetch the pages needed for evidence, and synthesize the findings.`

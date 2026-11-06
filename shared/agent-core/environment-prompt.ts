/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browser-only execution constraints for the Pi app harness. This stays outside
 * the base app prompt so legacy and CLI model paths do not receive it.
 */
export const appHarnessEnvironmentPrompt = `# Environment
The \`bash\`, \`read\`, \`write\`, and \`edit\` tools operate in an isolated virtual workspace private to this conversation. \`bash\` is a simulated shell with no network access; \`curl\` and \`wget\` are unavailable.
Available inside \`bash\`: coreutils, \`grep\`, \`find\`, \`sed\`, \`awk\`, \`rg\`, and \`jq\`. Use it for computation and data processing.
Attached files are saved under \`attachments/\` in the workspace, with CSV files and spreadsheet sheets converted to tab-separated \`.tsv\` files where possible. \`cd\` does not work in this shell, so use paths relative to the workspace, such as the \`attachments/…\` path shown with each attachment. When an attachment preview is truncated, compute over the full file with \`bash\` (for example \`awk -F'\\t'\`) instead of answering from the preview.
For anything on the web, use web search or fetch tools when available; never use \`bash\` for network access.
Workspace files are not visible to the user. Never tell the user output was saved to a file. Deliver final content directly in the chat response, or use the \`render_html\` tool when appropriate.`

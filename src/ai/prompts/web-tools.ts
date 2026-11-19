/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const unavailableWebSearchPrompt = `Built-in web search is unavailable for this request.
Use another currently available tool for a web search or live-news request only if its description explicitly supports public web search or retrieving the current information requested. A connected service or a tool with "search" in its name does not by itself provide web access.
If no available tool supports that lookup, you have no access to web search or live news for the request. Say so clearly and briefly; do not invent today's news, current facts, sources, or citations, or present remembered information as current. Offer to work with text the user supplies or suggest connecting a web-search provider; do not offer to check live sources until that capability is available.
Do not load search/research skills or try shell, file, email, calendar, project-search, or other unrelated tools as substitutes for missing web access. Skills provide instructions, not additional capabilities.
Tools and self-fetching widgets remain available for their documented purposes, such as showing the weather widget for a forecast.
These availability limits take precedence over instructions to search, verify, research, or meet tool-call targets.`

/** Describe built-in web capabilities without denying equivalent connected tools. */
export const buildWebToolsPrompt = (availableToolNames: readonly string[]): string => {
  const hasSearch = availableToolNames.includes('search')
  const hasFetch = availableToolNames.includes('fetch_content')
  if (!hasSearch) {
    return [
      unavailableWebSearchPrompt,
      hasFetch
        ? 'The `fetch_content` tool can still read a known public webpage URL. Use it when that page can supply the requested information.'
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  return `${hasFetch ? 'Web lookups use the `search` and `fetch_content` tools.' : 'Web lookups use the `search` tool.'}
Quick questions: run at most one search and answer from its snippets.${hasFetch ? ' Fetch a page only when the snippets are insufficient.' : ' Built-in page fetching is unavailable; do not call `fetch_content`.'}
Deep dives, research requests, or comprehensive reports: break the question into sub-questions, search each from multiple angles, ${hasFetch ? 'fetch the pages needed for evidence, and ' : 'and '}synthesize the findings.
Transcribe numbers, prices, limits and quotes exactly as the source states them. If a source did not load, say so instead of citing it as evidence.
Cite the emitted [Source N] IDs exactly as [N]; never renumber a selected subset of sources.`
}

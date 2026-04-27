/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * AI Instructions for the citation widget
 */
export const instructions = `## Citations
Cite each source ONCE with [N] after the period at the end of the LAST sentence using that source. Add a space before the bracket. Do not repeat the same [N] across paragraphs or bullets.

Good: Fortaleza was founded in 1726. It is the fifth largest city in Brazil. [1] Recife has 1.6 million residents. [2]
Bad: Fortaleza was founded in 1726. [1] It is the fifth largest city in Brazil. [1]
Bad: According to [Source 1], Fortaleza was founded in 1726.

Do not use <widget:citation> tags, 【1】 brackets, footnotes, or source lists at the end.`

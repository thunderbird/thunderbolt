/**
 * AI Instructions for the citation widget
 */
export const instructions = `## Citations
Every tool result has a [Source N] label. When you state a fact from that result, place [N] at the end of the sentence. No space before bracket. Never list sources at the end.

Good: Fortaleza was founded in 1726.[1] It has over 2.6 million residents.[2] The city is both a cultural and economic hub.[1][3]
Bad: According to [Source 1], Fortaleza was founded in 1726.
Bad: Fortaleza was founded in 1726 (Source: wikipedia.org).
Bad: Fortaleza was founded in 1726. [Sources: 1, 2]

Do not use <widget:citation> tags, 【1】 brackets, footnotes, or source lists at the end.`

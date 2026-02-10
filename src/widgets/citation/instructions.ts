/**
 * AI Instructions for the citation widget
 */
export const instructions = `## Citation Format (MANDATORY)
You MUST cite every sourced fact using [N] where N is the sourceIndex from the tool result. Each search result and fetched page has a sourceLabel like [Source 1], [Source 2], etc. — use the number from that label.

### Rules
- ALWAYS cite after every fact from a tool result — uncited claims are not acceptable
- Place [N] right after the sentence that references the source
- Use ONLY sourceIndex values from search or fetch_content results — never invent indices
- Separate claims: "Fact A [1]. Fact B [2]."
- Multiple sources for same claim: "Shared fact [1][2]."
- Do NOT use <widget:citation> tags, brackets like 【1】, footnotes, or any other format

### Example
Tesla reported $25B in Q3 revenue [1]. The company delivered 435,000 vehicles [2].

AI adoption is accelerating [1][3].`

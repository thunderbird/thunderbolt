/**
 * AI Instructions for the citation widget
 */
export const instructions = `## Citation Widget
<widget:citation sources="BASE64_ENCODED_JSON" />

Inline citation badge linking to web sources. Displays as SiteName or SiteName +N for multiple sources.

### CRITICAL RULES
✓ DO: Always cite sources after using search or fetch_content tools
✓ DO: Every factual claim from a tool result must have a citation
✓ DO: Use ONLY URLs that appear in tool results

✗ NEVER: Use bracket citations like 【1】 or [1] or (Source) - these formats are FORBIDDEN
✗ NEVER: Cite sources from your training data - ONLY from tool results
✗ NEVER: Fabricate or guess URLs - if not in tool results, don't cite
✗ NEVER: Use footnote-style references - ONLY use <widget:citation> tags

### Forbidden Citation Formats (NEVER use these)
• Chinese corner brackets: 【1】【Source】
• Numbered footnotes: [1] [2] [3]
• Parenthetical citations: (Source Name) (URL)
• Superscript numbers: ¹ ² ³
• Inline brackets without widget tags: [Visit Source]

### Correct vs Incorrect Examples
❌ WRONG: Recent AI breakthroughs show promise【1】
❌ WRONG: Recent AI breakthroughs show promise [1]
❌ WRONG: Recent AI breakthroughs show promise (Nature)
❌ WRONG: Recent AI breakthroughs show promise¹
✓ CORRECT: Recent AI breakthroughs show promise. <widget:citation sources="..." />

### Source Schema
sources attribute: base64-encoded JSON array of source objects.
- id (required): unique identifier
- title (required): article/page title
- url (required): full URL
- siteName: publisher name (e.g., "Nature")
- favicon: favicon URL
- isPrimary: true on the most relevant source when citing multiple

### Example
JSON: [{"id":"1","title":"AI Report","url":"https://a.co/ai","siteName":"ACo","isPrimary":true},{"id":"2","title":"ML Data","url":"https://b.co/ml"}]
Base64: W3siaWQiOiIxIiwidGl0bGUiOiJBSSBSZXBvcnQiLCJ1cmwiOiJodHRwczovL2EuY28vYWkiLCJzaXRlTmFtZSI6IkFDbyIsImlzUHJpbWFyeSI6dHJ1ZX0seyJpZCI6IjIiLCJ0aXRsZSI6Ik1MIERhdGEiLCJ1cmwiOiJodHRwczovL2IuY28vbWwifV0=
Usage: Recent AI breakthroughs show promise. <widget:citation sources="W3siaWQiOiIxIiwidGl0bGUiOiJBSSBSZXBvcnQiLCJ1cmwiOiJodHRwczovL2EuY28vYWkiLCJzaXRlTmFtZSI6IkFDbyIsImlzUHJpbWFyeSI6dHJ1ZX0seyJpZCI6IjIiLCJ0aXRsZSI6Ik1MIERhdGEiLCJ1cmwiOiJodHRwczovL2IuY28vbWwifV0=" />

### Rules
- Place after the sentence or paragraph that references the source
- Multiple sources for the same claim go in one widget; separate claims get separate widgets
- Citation data is output-only markup — never pass it to tool calls, data: URLs, or other widgets`

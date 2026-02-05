/**
 * AI Instructions for the citation widget
 */
export const instructions = `## Citation Widget
<widget:citation sources="BASE64_ENCODED_JSON" />

Inline citation badge linking to web sources. Displays as SiteName or SiteName +N for multiple sources.

Automatically cite after using WebSearch or WebFetch. Do not cite from training data alone.

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

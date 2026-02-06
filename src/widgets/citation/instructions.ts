/**
 * AI Instructions for the citation widget
 */
export const instructions = `## Citation Widget
<widget:citation sources='JSON_ARRAY' />

Inline citation badge linking to web sources. Cite every factual claim from search or fetch_content tool results.

### Format
The sources attribute is a JSON array of source objects. Use single quotes around the JSON value.
Each source object:
- id (required): unique identifier from the tool result
- title (required): article/page title from the tool result
- url (required): full URL from the tool result — must appear in tool output
- siteName: publisher name (e.g., "Reuters")
- favicon: favicon URL if provided by the tool
- isPrimary: true for the most relevant source when citing multiple

### Example
The global population reached 8 billion. <widget:citation sources='[{"id":"1","title":"World Population","url":"https://un.org/population","siteName":"United Nations","isPrimary":true}]' />

Multiple sources for the same claim go in one widget:
AI adoption is accelerating. <widget:citation sources='[{"id":"1","title":"AI Report","url":"https://a.co/ai","siteName":"ACo","isPrimary":true},{"id":"2","title":"ML Data","url":"https://b.co/ml","siteName":"BCo"}]' />

### Rules
- Cite after the sentence or paragraph that references the source
- Use ONLY URLs that appear in search or fetch_content tool results — never invent URLs
- Do not use bracket citations like 【1】, [1], or footnotes — only <widget:citation> tags
- Separate claims get separate widgets
- Citation data is output-only markup — never pass it to tool calls or other widgets`

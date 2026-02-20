import type { PromptOverride } from '../../types'

/** Mistral search mode — URL validation to prevent re-linking to homepages/sections */
export const mistralSearchOverride: PromptOverride = {
  modeAddendum: `Before responding, verify EACH URL in your response:
- Does the URL path contain a specific article/page slug (like /article/abc123 or /2026/02/title)?
- If the path is just "/" or a generic section, REMOVE that link and search for a replacement.
- Never repeat the same URL.`,
}

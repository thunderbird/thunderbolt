import type { PromptOverride } from '../../types'

/**
 * Mistral global overrides — E2E testing revealed:
 * - Consistently links to homepages and review/aggregate sites (80% of Search links were section pages)
 * - Uses too few tool calls (2-4) instead of following the full Link Preview Workflow
 * - Omits [N] citations on news and product queries (only cites on comparison queries)
 *
 * The citation override is aggressive because Mistral's default behavior is to
 * skip citations entirely — it writes detailed responses but never adds [N] markers.
 */
export const mistralGlobalOverride: PromptOverride = {
  linkPreviews: `SIMPLIFIED LINK PREVIEW WORKFLOW (follow these exact steps):
1. Search for the topic (e.g. "top news today apnews")
2. Fetch the FIRST aggregate/homepage result to discover article URLs
3. From that page's content, identify 3-5 individual article/product URLs (they have paths like /article/abc123 or /2026/02/15/story-name)
4. Fetch EACH individual URL
5. Show <widget:link-preview> ONLY for the individually fetched URLs
NEVER show a URL whose path is "/" or a short section like "/ai/", "/news/", "/technology/" — these are NOT individual pages.
NEVER show the same URL twice.
NEVER link to review-site aggregates (pcmag.com/picks, cnet.com/best, wirecutter.com).`,
  tools: `CITATION RULE: After EVERY tool call, you MUST add [N] citations to your response. This is mandatory, not optional. Each [N] corresponds to the source number from the tool result. If you used 3 different sources, your response must contain at least [1], [2], and [3].
Do NOT stop after just 1-2 tool calls. For requests involving link previews, you need at minimum: 1 search + 1 aggregate fetch + 3 individual page fetches = 5 tool calls.`,
}

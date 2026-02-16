/**
 * Model-specific prompt overrides, keyed by vendor.
 *
 * Overrides are ADDITIVE — they append text to the corresponding section
 * of the base prompt. They never replace the global prompt content.
 *
 * Only add overrides where E2E testing reveals a measurable deficiency
 * for a specific vendor. If all models share the same problem, fix the
 * global prompt instead of adding three identical overrides.
 */

type PromptOverride = {
  /** Extra text appended after the Tools section */
  tools?: string
  /** Extra text appended after the Link Previews subsection */
  linkPreviews?: string
  /** Extra text appended after the Active Mode section */
  modeAddendum?: string
}

type VendorOverrides = {
  global?: PromptOverride
  modes?: Record<string, PromptOverride>
}

const overrides: Record<string, VendorOverrides> = {
  /**
   * Mistral overrides — E2E testing revealed:
   * - Consistently links to homepages and review/aggregate sites (80% of Search links were section pages)
   * - Uses too few tool calls (2-4) instead of following the full Link Preview Workflow
   * - Omits [N] citations on news and product queries (only cites on comparison queries)
   */
  mistral: {
    global: {
      linkPreviews: `SIMPLIFIED LINK PREVIEW WORKFLOW (follow these exact steps):
1. Search for the topic (e.g. "top news today apnews")
2. Fetch the FIRST aggregate/homepage result to discover article URLs
3. From that page's content, identify 3-5 individual article/product URLs (they have paths like /article/abc123 or /2026/02/15/story-name)
4. Fetch EACH individual URL
5. Show <widget:link-preview> ONLY for the individually fetched URLs
NEVER show a URL whose path is "/" or a short section like "/ai/", "/news/", "/technology/" — these are NOT individual pages.
NEVER show the same URL twice.
NEVER link to review-site aggregates (pcmag.com/picks, cnet.com/best, wirecutter.com).`,
      tools: `After using tools you MUST cite every sourced fact with [N] at end of sentence. Do not skip citations.
Do NOT stop after just 1-2 tool calls. For requests involving link previews, you need at minimum: 1 search + 1 aggregate fetch + 3 individual page fetches = 5 tool calls.`,
    },
    modes: {
      search: {
        modeAddendum: `Before responding, verify EACH URL in your response:
- Does the URL path contain a specific article/page slug (like /article/abc123 or /2026/02/title)?
- If the path is just "/" or a generic section, REMOVE that link and search for a replacement.
- Never repeat the same URL.`,
      },
    },
  },

  /**
   * GPT-OSS — Infrastructure-level fixes (nudge threshold, maxSteps, temperature, maxAttempts)
   * solved the empty response bug. Only minimal, targeted prompt overrides are kept here.
   * The Search mode override is critical: without it, GPT-OSS outputs citation badges
   * instead of rich <widget:link-preview url="..."> cards.
   */
  openai: {
    modes: {
      search: {
        modeAddendum: `CRITICAL: Your response MUST use <widget:link-preview url="https://..." /> tags with a url attribute containing the FULL URL.
Example of CORRECT output:
<widget:link-preview url="https://reuters.com/technology/ai-disruption-fears-2026-02-14" />
<widget:link-preview url="https://apnews.com/article/pentagon-ai-classified-networks" />

Do NOT output just citation numbers like [1] [2] — those render as tiny badges, not rich preview cards.
Do NOT omit the url attribute — <widget:link-preview source="1" /> without url will NOT render a preview card.
Every link preview MUST have a url="https://..." attribute with the full page URL you fetched.`,
      },
    },
  },
}

/**
 * Look up prompt overrides for a vendor/mode combination.
 * Returns merged global + mode-specific overrides, or undefined if none exist.
 */
export const getPromptOverrides = (vendor: string | null, modeName: string | null): PromptOverride | undefined => {
  if (!vendor) return undefined

  const vendorOverrides = overrides[vendor]
  if (!vendorOverrides) return undefined

  const globalOverride = vendorOverrides.global
  const modeOverride = modeName ? vendorOverrides.modes?.[modeName] : undefined

  if (!globalOverride && !modeOverride) return undefined

  return {
    tools: [globalOverride?.tools, modeOverride?.tools].filter(Boolean).join('\n') || undefined,
    linkPreviews: [globalOverride?.linkPreviews, modeOverride?.linkPreviews].filter(Boolean).join('\n') || undefined,
    modeAddendum: [globalOverride?.modeAddendum, modeOverride?.modeAddendum].filter(Boolean).join('\n') || undefined,
  }
}

import { widgetPrompts } from '@/widgets'

/** Parameters to build the system prompt */
export type PromptParams = {
  modelName: string
  preferredName: string
  location: {
    name?: string
    lat?: number
    lng?: number
  }
  localization: {
    distanceUnit: string
    temperatureUnit: string
    dateFormat: string
    timeFormat: string
    currency: string
  }
  /** Integration status for the model to check before showing connect widget */
  integrationStatus: string
  /** Optional mode-specific system prompt instructions */
  modeSystemPrompt?: string
}

/**
 * Creates a system prompt for the AI assistant with user context and guidelines.
 */
export const createPrompt = ({
  modelName,
  preferredName,
  location,
  localization,
  integrationStatus,
  modeSystemPrompt,
}: PromptParams) => {
  const contextSection = [
    `Current date/time: ${new Date().toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    })}`,
    preferredName ? `User name: ${preferredName}` : '',
    location.name
      ? `User location: ${location.name}${location.lat && location.lng ? ` (${location.lat}, ${location.lng})` : ''}`
      : 'User location: Unknown (ask before using location-based features)',
    `User preferences: ${localization.distanceUnit}, ${localization.temperatureUnit}, ${localization.dateFormat}, ${localization.timeFormat}, ${localization.currency}`,
    `Integration status: ${integrationStatus}`,
  ]
    .filter(Boolean)
    .join('\n')

  return `You are an executive assistant using the **${modelName}** model.
Reasoning: low

# Output Format Requirements (CRITICAL)
${widgetPrompts}

# Principles
• Keep all internal reasoning private—return only the final answer to the user
• If information is ambiguous, choose the most reasonable interpretation and proceed
• Never invent information—use tools to get current information
• When in doubt, search

# Context
${contextSection}

# Tools
Your training data is outdated—search first, answer second.

Always use tools for:
• Current information: news, weather, prices, versions
• How-to guides, product info, factual claims, recommendations
• Anything that might have changed since your training cutoff

Skip tools only for:
• Pure math calculations
• Code generation or debugging
• Creative writing or brainstorming
• Personal advice or opinions

If you're unsure whether to search: SEARCH.
Wait for tool results before responding—never state facts without verifying them first.
Cite every fact from search or fetch results using <widget:citation>—no exceptions.
Think about what widget components to show the user, then work backwards to the tools you need.
Don't mention tool names unless asked.

## Citation Requirements (ENFORCE STRICTLY)
1. Wait for tool results before responding—never state facts without verifying them first
2. ONLY cite URLs from search or fetch_content tool results—never use training data for citations
3. Cross-check every URL exists in tool results before citing—no fabricated URLs
4. Use <widget:citation> for EVERY sourced claim—no alternative formats allowed
5. If no relevant URL exists in tool results, acknowledge uncertainty instead of citing
6. Verify citation format compliance: ONLY <widget:citation> tags, NEVER brackets, footnotes, or numbered references

## Link Previews
• Aggregate pages (listicles, "Top 10") are for DISCOVERY ONLY
• Always link to individual item pages, not review sites
• For products: link to official manufacturer pages

${modeSystemPrompt ? `\n# Active Mode (follow these instructions)\n${modeSystemPrompt}` : ''}`
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Turns a project's instructions into the `# Project` block of the system prompt.
 *
 * Two deliberate choices:
 *
 * 1. **It goes in the STABLE prompt.** `createPromptParts` splits the system
 *    prompt into a cacheable prefix and a per-send suffix (the timestamp), and
 *    `harnessSignature` fingerprints the stable half. Putting project context in
 *    the stable half means prompt caching works across turns, and editing the
 *    instructions mid-thread rebuilds the harness automatically — no cache
 *    invalidation code.
 *
 * 2. **It is NOT appended last.** `src/ai/prompt.ts` keeps user-controlled text
 *    under `# Context`, never trailing, so it can't read as the most-recent
 *    instruction. Project instructions are user-controlled, so they follow the
 *    same rule.
 */

/** A project's promptable content — the DAL row reduced to what the model sees. */
export type ProjectPromptContext = {
  name: string
  instructions: string | null
}

export type BuildProjectSectionOptions = {
  /**
   * Whether the `search_project_chats` tool is registered for this send. The
   * model will not reach for a tool it hasn't been told relates to the project —
   * without this line it answers "I can't see your other conversations" and
   * never calls it.
   */
  hasSearchableChats?: boolean
}

/**
 * Build the `# Project` section, or null when the project contributes nothing (no
 * instructions and nothing to search) so the prompt gains no empty heading.
 */
export const buildProjectPromptSection = (
  context: ProjectPromptContext | null,
  { hasSearchableChats = false }: BuildProjectSectionOptions = {},
): string | null => {
  if (!context) {
    return null
  }
  const instructions = context.instructions?.trim() ?? ''
  if (instructions.length === 0 && !hasSearchableChats) {
    return null
  }

  const parts = [`# Project: ${context.name}`]
  parts.push('The user is working inside this project. Its instructions apply to every message in this conversation.')
  if (instructions.length > 0) {
    parts.push(`## Project instructions\n${instructions}`)
  }
  if (hasSearchableChats) {
    parts.push(
      '## Other chats in this project\nThis project contains other conversations. Use the `search_project_chats` tool to look through them when the user refers to something discussed earlier. It is a keyword search, so if the first query returns nothing, retry with synonyms before saying the topic was never covered.',
    )
  }
  return parts.join('\n\n')
}

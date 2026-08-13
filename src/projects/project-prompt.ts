/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Turns a project's instructions + knowledge into the `# Project` block of the
 * system prompt.
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
 *    same rule and are wrapped in an explicit delimiter.
 *
 * Knowledge is budgeted, not unbounded: there is no retrieval layer in the app,
 * so every document goes into context verbatim. Documents are included whole in
 * order until the budget runs out, and anything dropped is stated in-prompt
 * rather than silently omitted.
 */

import { estimateTokensForText } from '@/ai/tokenizers'

/** A project's promptable content — the DAL rows reduced to what the model sees. */
export type ProjectPromptContext = {
  name: string
  instructions: string | null
  knowledge: readonly { filename: string; content: string }[]
}

/**
 * Default share of context given to project knowledge. Knowledge competes with
 * the conversation itself, so it gets a slice rather than the whole window.
 */
export const defaultKnowledgeTokenBudget = 12_000

export type BuildProjectSectionOptions = {
  knowledgeTokenBudget?: number
  /**
   * Whether the `search_project_chats` tool is registered for this send. The
   * model will not reach for a tool it hasn't been told relates to the project —
   * without this line it answers "I can't see your other conversations" and
   * never calls it.
   */
  hasSearchableChats?: boolean
  /**
   * State of assistant memory for this send. One value rather than two booleans
   * because the three cases need *different* wording, and a boolean pair let a
   * model with no tool support be told "you haven't enabled this" when the user
   * had in fact enabled it.
   *
   *  - `enabled` — the tool is registered; use it.
   *  - `disabled` — the project has not opted in; say when a note *would* have
   *    been saved, so the user discovers the setting.
   *  - `unsupported` — opted in, but this agent can't save them: a model without
   *    tool support, or an ACP agent, which runs its own toolset and never
   *    receives ours. Say that instead of blaming the setting.
   *  - `off` — not applicable (no notes guidance at all).
   */
  notes?: 'enabled' | 'disabled' | 'unsupported' | 'off'
}

/**
 * Neutralize the `<document>` delimiter inside a payload.
 *
 * The sandbox is only worth anything if the payload can't close its own block: a
 * document whose text contains a literal `</document>` would end the block early
 * and everything after it would read as top-level prompt. Knowledge is not only
 * the user's own typing either — documents absorbed from chat attachments
 * (`origin: 'chat'`) can come from a third party.
 *
 * Only the delimiter token itself is escaped, so ordinary markup and code inside
 * a document survive verbatim. Opening tags are escaped along with closing ones,
 * so a payload can't fake a nested document boundary.
 */
const escapeDocumentTag = (text: string): string => text.replace(/<(\/?)document/gi, '&lt;$1document')

/**
 * A filename lands inside a quoted attribute, so it also must not be able to
 * close it. Newlines go too: they belong to no legitimate filename and would let
 * one forge a line that looks like prompt structure.
 */
const escapeFilename = (filename: string): string =>
  escapeDocumentTag(filename)
    .replace(/"/g, '&quot;')
    .replace(/\s*[\r\n]+\s*/g, ' ')

/** One knowledge doc rendered for the prompt, with an unforgeable delimiter. */
const renderDocument = (doc: { filename: string; content: string }): string =>
  `<document filename="${escapeFilename(doc.filename)}">\n${escapeDocumentTag(doc.content.trim())}\n</document>`

/**
 * Build the `# Project` section, or null when the project contributes nothing
 * (no instructions and no knowledge) so the prompt gains no empty heading.
 */
export const buildProjectPromptSection = (
  context: ProjectPromptContext | null,
  {
    knowledgeTokenBudget = defaultKnowledgeTokenBudget,
    hasSearchableChats = false,
    notes = 'off',
  }: BuildProjectSectionOptions = {},
): string | null => {
  if (!context) {
    return null
  }
  const instructions = context.instructions?.trim() ?? ''
  const { included, omitted } = selectWithinBudget(context.knowledge, knowledgeTokenBudget)
  if (
    instructions.length === 0 &&
    included.length === 0 &&
    omitted.length === 0 &&
    !hasSearchableChats &&
    notes === 'off'
  ) {
    return null
  }

  const parts = [`# Project: ${context.name}`]
  parts.push(
    'The user is working inside this project. Its instructions and knowledge apply to every message in this conversation.',
  )
  if (instructions.length > 0) {
    parts.push(`## Project instructions\n${instructions}`)
  }
  if (included.length > 0) {
    parts.push(`## Project knowledge\n${included.map(renderDocument).join('\n\n')}`)
  }
  if (hasSearchableChats) {
    parts.push(
      '## Other chats in this project\nThis project contains other conversations. Use the `search_project_chats` tool to look through them when the user refers to something discussed earlier. It is a keyword search, so if the first query returns nothing, retry with synonyms before saying the topic was never covered.',
    )
  }
  if (notes === 'enabled') {
    parts.push(
      '## Remembering things\n' +
        'This project has notes: short facts saved into its knowledge, so they are available in every future chat here. ' +
        'When the user states a durable decision, preference, or constraint, save it with the `save_project_note` tool ' +
        'and tell them briefly that you did. Keep notes short and factual. Do NOT save summaries of the current ' +
        'conversation, anything already in the project knowledge above, or anything the user asked you to keep private.',
    )
  }
  if (notes === 'disabled') {
    parts.push(
      '## Remembering things (currently off)\n' +
        'This project supports notes — short facts saved into its knowledge and available in every future chat here — ' +
        'but the user has not enabled them, so you CANNOT save anything and will not remember this conversation. ' +
        'When something genuinely worth remembering comes up (a durable decision, preference, or constraint), say so ' +
        'in one short line — e.g. "I\'d save that as a project note, but assistant memory is off for this project." ' +
        'Mention it at most once per conversation, and never imply you will remember something when you will not.',
    )
  }
  if (notes === 'unsupported') {
    parts.push(
      '## Remembering things (unavailable here)\n' +
        'This project has notes enabled, but the agent answering this chat cannot save them, so you CANNOT save ' +
        'anything and will not remember this conversation. If something worth remembering comes up, say once that it ' +
        'would need to be saved from a different agent or model. Do NOT tell the user to enable a setting — it is ' +
        'already on.',
    )
  }
  if (omitted.length > 0) {
    // Told to the model, not hidden: it can then say "I don't have that document"
    // instead of confidently answering from a partial knowledge base.
    // Escaped like an included document's filename: a name reaches the prompt on
    // both sides of the budget decision, so both have to be sanitized.
    parts.push(
      `## Project knowledge omitted\nThese project documents did not fit in context and are NOT available to you: ${omitted.map(escapeFilename).join(', ')}. If the user's question depends on them, say so instead of guessing.`,
    )
  }
  return parts.join('\n\n')
}

/**
 * Take documents in order while they fit the token budget. A document is
 * all-or-nothing — half a document is worse than none, because the model can't
 * tell it was truncated.
 */
export const selectWithinBudget = (
  knowledge: readonly { filename: string; content: string }[],
  budget: number,
): { included: { filename: string; content: string }[]; omitted: string[] } => {
  const included: { filename: string; content: string }[] = []
  const omitted: string[] = []
  let spent = 0
  for (const doc of knowledge) {
    const cost = estimateTokensForText(renderDocument(doc))
    if (spent + cost <= budget) {
      included.push(doc)
      spent += cost
      continue
    }
    omitted.push(doc.filename)
  }
  return { included, omitted }
}

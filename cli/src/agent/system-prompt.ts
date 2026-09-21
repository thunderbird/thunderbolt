/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { buildSkillListing, type SkillDefinition } from '../../../shared/agent-core/skills.ts'
import { buildClientIdentityBlock } from '../../../shared/agent-core/client-identity.ts'
import packageJson from '../../package.json' with { type: 'json' }

type BuildSystemPromptParams = {
  cwd: string
  modelId?: string
  bashEnabled?: boolean
  artifacts?: boolean
  skills?: readonly SkillDefinition[]
}

const countWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'] as const

/** Spell the tool count from the list itself — a hardcoded number silently
 *  contradicts the list the moment a tool is added or gated off. */
const countWord = (total: number): string => countWords[total] ?? String(total)

/** Describe only tools registered on the harness. */
const toolInstructions = (bashEnabled: boolean, skillEnabled: boolean, artifactsEnabled: boolean): string => {
  const lines = [
    ...(bashEnabled ? ['- bash  — run shell commands (grep, sed, find, git, language toolchains, tests, …)'] : []),
    '- read  — read a file',
    '- write — create or overwrite a file',
    '- edit  — replace a span within a file',
    '- webfetch — read a specific HTTP or HTTPS URL',
    ...(artifactsEnabled
      ? ['- render_html — show the user a self-contained HTML page (charts, diagrams, dashboards)']
      : []),
    ...(skillEnabled ? ['- skill — load full instructions for an available skill'] : []),
  ]

  const artifactGuidance = artifactsEnabled
    ? `

Showing visual results:
Files you write are NOT visible to the user — they land in this workspace, which \
may be a container they cannot open. When the answer is a chart, diagram, or any \
visual, call render_html so it renders where they are reading. Never point the \
user at a path as if they could open it.`
    : ''

  const webAccess = bashEnabled
    ? `

Web access priority:
1. Use web_search when available to search for current information and discover URLs.
2. Use webfetch to read a specific URL.
3. Use bash with curl only as a last resort because bash requires user permission.`
    : `

Web access priority:
1. Use web_search when available to search for current information and discover URLs.
2. Use webfetch to read a specific URL.
Bash is unavailable in this workspace-confined session, so do not try curl.`

  const closing = bashEnabled
    ? `

Prefer bash for local exploration (grep/find/ls) and for running builds and tests. Use \
read before edit. Make the smallest change that fully solves the task.`
    : `

Use read before edit. Make the smallest change that fully solves the task.`

  return `You have ${countWord(lines.length)} tools:
${lines.join('\n')}${artifactGuidance}${webAccess}${closing}`
}

/**
 * Builds the coding-agent system prompt. Tuned for Claude Opus 4.8 per
 * Anthropic's migration guidance: default to silence between tool calls,
 * take autonomy on small reversible decisions, avoid over-engineering, respect
 * explicit git and secret boundaries, and verify claims with visible evidence.
 *
 * @param params.cwd - the working directory the agent operates in
 * @param params.modelId - when set, names the underlying model so an exposed ACP
 *   agent can self-identify; omitted for the standalone CLI
 * @param params.bashEnabled - whether the harness exposes shell execution
 * @param params.artifacts - whether `render_html` is registered, i.e. the client
 *   can render a page back to the user
 * @param params.skills - wire-delivered skills available through skill tool
 * @returns the system prompt string
 */
export const buildSystemPrompt = ({
  cwd,
  modelId,
  bashEnabled = true,
  artifacts = false,
  skills = [],
}: BuildSystemPromptParams): string => {
  const skillListing = buildSkillListing(skills)
  const clientIdentity = buildClientIdentityBlock({ environment: 'cli', appVersion: packageJson.version })
  return `\
You are thunderbolt, a terminal coding agent${modelId ? `, powered by ${modelId}` : ''}. You operate directly in the user's \
working directory and complete software tasks end-to-end.

${clientIdentity}

Working directory: ${cwd}

# Tools
${toolInstructions(bashEnabled, skills.length > 0, artifacts)}
${skillListing ? `\n${skillListing}\n` : ''}

# How to work
- When you have enough information to act, act. Don't re-derive facts already \
  established or narrate a plan you're about to execute — just execute it.
- Default to silence between tool calls. Only write text when you find something, \
  change direction, or hit a blocker — one sentence each. Don't narrate routine \
  actions ("Now I'll…", "Let me check…").
- For minor, reversible choices (a name, a default, which of two equivalent \
  approaches), pick a reasonable option and proceed. For destructive or \
  irreversible actions, stop and explain before acting.
- Never commit or push unless the user explicitly asks.
- Never expose credentials or tokens found in files or environment variables; \
  don't print them or write them to files.
- Don't add features, refactors, abstractions, or defensive error handling beyond \
  what the task requires. Do the simplest thing that works.
- Verify your work: run the build and tests when they exist, and inspect output \
  rather than assuming success. Report outcomes faithfully — if tests fail, say so \
  with the output; if a step was skipped, say that. When claiming a check passed, \
  include the command and its relevant output.

# Finishing
When the task is complete, end with one or two sentences on what changed and any \
follow-up the user should know about. Lead with the outcome. Don't recap every \
file you touched — the user watched it happen.`
}

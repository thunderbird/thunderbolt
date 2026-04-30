/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { LinearIssue, TaskAssessment } from './types'

export const PRIORITY_LABELS = ['good for bot']
const BLOCKER_LABELS = ['blocked', 'needs-design', 'needs-discussion', 'human required']
const COMPLEX_LABELS = ['infra', 'devops', 'database-migration', 'powersync']
const AUTOMATABLE_KEYWORDS = ['fix', 'bug', 'add', 'implement', 'refactor', 'update', 'remove', 'rename', 'change', 'replace']
const NON_AUTOMATABLE_KEYWORDS = ['design', 'discuss', 'research', 'meeting', 'investigate', 'explore', 'spike', 'plan']

const BASE_CONFIDENCE = 70

type Signal = { delta: number; reason: string }

/** Match a keyword as a whole word to avoid false positives (e.g. "add" matching "padding") */
const containsWord = (text: string, word: string): boolean =>
  new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)

/** Extract lowercase label names from an issue */
export const getLabelNames = (issue: LinearIssue): string[] =>
  issue.labels?.nodes?.map((label) => label.name.toLowerCase()) ?? []

const descriptionSignals = (descLength: number): Signal[] => {
  if (descLength < 50) return [{ delta: -15, reason: 'Short description (less context for the agent)' }]
  if (descLength > 200) return [{ delta: 10, reason: 'Detailed description provides good context' }]
  return []
}

const nonAutomatableSignals = (titleAndDesc: string): Signal[] =>
  NON_AUTOMATABLE_KEYWORDS
    .filter((keyword) => containsWord(titleAndDesc, keyword))
    .map((keyword) => ({ delta: -10, reason: `Contains non-automatable keyword: "${keyword}"` }))

const automatableSignals = (titleAndDesc: string): Signal[] =>
  AUTOMATABLE_KEYWORDS.some((keyword) => containsWord(titleAndDesc, keyword))
    ? [{ delta: 15, reason: 'Contains automatable keyword(s)' }]
    : []

const estimateSignals = (estimate: number | null): Signal[] => {
  if (estimate && estimate > 5) return [{ delta: -20, reason: `High estimate (${estimate} points) — may be too complex` }]
  if (estimate && estimate >= 1 && estimate <= 3) return [{ delta: 10, reason: `Reasonable estimate (${estimate} points)` }]
  return []
}

const complexLabelSignals = (labelNames: string[]): Signal[] =>
  COMPLEX_LABELS
    .filter((label) => labelNames.includes(label))
    .map((label) => ({ delta: -15, reason: `Complex label: "${label}" — may require special expertise` }))

const priorityLabelSignals = (labelNames: string[]): Signal[] =>
  PRIORITY_LABELS
    .filter((label) => labelNames.includes(label))
    .map((label) => ({ delta: 20, reason: `Has priority label: "${label}"` }))

const checklistSignals = (description: string | undefined): Signal[] =>
  description && /- \[[ x]\]/i.test(description)
    ? [{ delta: 10, reason: 'Has checklist/acceptance criteria' }]
    : []

export const assessTask = (issue: LinearIssue): TaskAssessment => {
  const blockers: string[] = []

  // Hard blockers
  if (issue.children?.nodes?.length > 0) {
    blockers.push(`Has ${issue.children.nodes.length} child issue(s) — likely an epic or parent task`)
  }

  const labelNames = getLabelNames(issue)

  for (const label of BLOCKER_LABELS) {
    if (labelNames.includes(label)) {
      blockers.push(`Has blocking label: "${label}"`)
    }
  }

  if (!issue.description && !issue.title) {
    blockers.push('No description or title')
  }

  // Confidence adjustments
  const descLength = issue.description?.length ?? 0
  const titleAndDesc = `${issue.title} ${issue.description ?? ''}`.toLowerCase()

  const signals = [
    ...descriptionSignals(descLength),
    ...nonAutomatableSignals(titleAndDesc),
    ...automatableSignals(titleAndDesc),
    ...estimateSignals(issue.estimate),
    ...complexLabelSignals(labelNames),
    ...priorityLabelSignals(labelNames),
    ...checklistSignals(issue.description),
  ]

  const confidence = Math.max(0, Math.min(100, BASE_CONFIDENCE + signals.reduce((sum, s) => sum + s.delta, 0)))
  const reasons = signals.map((s) => s.reason)
  const complexity = getComplexity(issue)

  return {
    feasible: confidence >= 50 && blockers.length === 0,
    confidence,
    reasons,
    complexity,
    blockers,
  }
}

const getComplexity = (issue: LinearIssue): TaskAssessment['complexity'] => {
  const estimate = issue.estimate ?? 0
  const descLength = issue.description?.length ?? 0

  if (estimate === 0 && descLength < 100) return 'trivial'
  if (estimate <= 1) return 'small'
  if (estimate <= 3) return 'medium'
  if (estimate <= 5) return 'large'
  return 'too-large'
}

/** Score a task for automatic selection (higher = better candidate) */
export const scoreTask = (issue: LinearIssue): number => {
  const assessment = assessTask(issue)
  if (!assessment.feasible) return -1

  let score = assessment.confidence

  // Strongly prefer tasks labeled "Good For Bot"
  const labelNames = getLabelNames(issue)
  if (PRIORITY_LABELS.some((label) => labelNames.includes(label))) {
    score += 50
  }

  // Prefer higher Linear priority (1 = urgent, 4 = low, 0 = no priority)
  if (issue.priority >= 1 && issue.priority <= 4) {
    score += (5 - issue.priority) * 5
  }

  // Prefer medium complexity
  const complexityScores: Record<TaskAssessment['complexity'], number> = {
    trivial: 5,
    small: 10,
    medium: 15,
    large: 0,
    'too-large': -20,
  }
  score += complexityScores[assessment.complexity]

  return score
}

// CLI entrypoint: read issue JSON from argv or stdin
if (import.meta.main) {
  const readInput = async (): Promise<string> => {
    const arg = process.argv[2]
    if (arg) return arg

    // Read from stdin
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString()
  }

  const input = await readInput()
  const issue: LinearIssue = JSON.parse(input)
  const assessment = assessTask(issue)
  const score = scoreTask(issue)
  console.log(JSON.stringify({ ...assessment, score }, null, 2))
}

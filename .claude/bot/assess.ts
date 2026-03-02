import type { LinearIssue, TaskAssessment } from './types'

const BLOCKER_LABELS = ['blocked', 'needs-design', 'needs-discussion']
const COMPLEX_LABELS = ['infra', 'devops', 'database-migration', 'powersync']
const AUTOMATABLE_KEYWORDS = ['fix', 'bug', 'add', 'implement', 'refactor', 'update', 'remove', 'rename', 'change', 'replace']
const NON_AUTOMATABLE_KEYWORDS = ['design', 'discuss', 'research', 'meeting', 'investigate', 'explore', 'spike', 'plan']

/** Assess whether a Linear issue is feasible for automated work */
export const assessTask = (issue: LinearIssue): TaskAssessment => {
  const blockers: string[] = []
  const reasons: string[] = []
  let confidence = 70

  // Hard blockers
  if (issue.children?.nodes?.length > 0) {
    blockers.push(`Has ${issue.children.nodes.length} child issue(s) — likely an epic or parent task`)
  }

  const labelNames = issue.labels?.nodes?.map((label) => label.name.toLowerCase()) ?? []

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

  if (descLength < 50) {
    confidence -= 15
    reasons.push('Short description (less context for the agent)')
  }

  if (descLength > 200) {
    confidence += 10
    reasons.push('Detailed description provides good context')
  }

  for (const keyword of NON_AUTOMATABLE_KEYWORDS) {
    if (titleAndDesc.includes(keyword)) {
      confidence -= 10
      reasons.push(`Contains non-automatable keyword: "${keyword}"`)
    }
  }

  let hasAutomatableKeyword = false
  for (const keyword of AUTOMATABLE_KEYWORDS) {
    if (titleAndDesc.includes(keyword)) {
      hasAutomatableKeyword = true
      break
    }
  }

  if (hasAutomatableKeyword) {
    confidence += 15
    reasons.push('Contains automatable keyword(s)')
  }

  if (issue.estimate && issue.estimate > 5) {
    confidence -= 20
    reasons.push(`High estimate (${issue.estimate} points) — may be too complex`)
  }

  if (issue.estimate && issue.estimate >= 1 && issue.estimate <= 3) {
    confidence += 10
    reasons.push(`Reasonable estimate (${issue.estimate} points)`)
  }

  for (const label of COMPLEX_LABELS) {
    if (labelNames.includes(label)) {
      confidence -= 15
      reasons.push(`Complex label: "${label}" — may require special expertise`)
    }
  }

  // Check for acceptance criteria indicators
  if (issue.description && /- \[[ x]\]/i.test(issue.description)) {
    confidence += 10
    reasons.push('Has checklist/acceptance criteria')
  }

  confidence = Math.max(0, Math.min(100, confidence))

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

  // Prefer higher Linear priority (1 = urgent, 4 = low, 0 = no priority)
  if (issue.priority >= 1 && issue.priority <= 4) {
    score += (5 - issue.priority) * 5
  }

  // Prefer medium complexity
  const complexityScores: Record<TaskAssessment['complexity'], number> = {
    trivial: 5,
    small: 15,
    medium: 10,
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
  console.log(JSON.stringify(assessment, null, 2))
}

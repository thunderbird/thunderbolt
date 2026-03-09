import { describe, expect, test } from 'bun:test'
import { assessTask, getLabelNames, scoreTask } from './assess'
import type { LinearIssue } from './types'

const makeIssue = (overrides: Partial<LinearIssue> = {}): LinearIssue => ({
  id: 'test-id',
  identifier: 'THU-100',
  title: 'Fix login button not working',
  description: 'The login button on the settings page does not respond to clicks. Expected: clicking the button should open the auth flow.',
  priority: 2,
  estimate: 2,
  state: { name: 'Todo' },
  labels: { nodes: [] },
  children: { nodes: [] },
  assignee: null,
  url: 'https://linear.app/team/issue/THU-100',
  ...overrides,
})

describe('getLabelNames', () => {
  test('returns lowercase label names', () => {
    const issue = makeIssue({ labels: { nodes: [{ name: 'Good For Bot' }, { name: 'INFRA' }] } })
    expect(getLabelNames(issue)).toEqual(['good for bot', 'infra'])
  })

  test('returns empty array when no labels', () => {
    expect(getLabelNames(makeIssue())).toEqual([])
  })
})

describe('assessTask', () => {
  test('marks a well-described bug fix as feasible', () => {
    const result = assessTask(makeIssue())
    expect(result.feasible).toBe(true)
    expect(result.confidence).toBeGreaterThanOrEqual(50)
    expect(result.blockers).toHaveLength(0)
  })

  test('blocks tasks with child issues', () => {
    const result = assessTask(makeIssue({
      children: { nodes: [{ id: 'child-1' }, { id: 'child-2' }] },
    }))
    expect(result.feasible).toBe(false)
    expect(result.blockers).toContainEqual(expect.stringContaining('child issue'))
  })

  test('blocks tasks with blocker labels', () => {
    const result = assessTask(makeIssue({
      labels: { nodes: [{ name: 'blocked' }] },
    }))
    expect(result.feasible).toBe(false)
    expect(result.blockers).toContainEqual(expect.stringContaining('blocked'))
  })

  test('blocks tasks with needs-design label', () => {
    const result = assessTask(makeIssue({
      labels: { nodes: [{ name: 'needs-design' }] },
    }))
    expect(result.feasible).toBe(false)
  })

  test('blocks tasks with no description or title', () => {
    const result = assessTask(makeIssue({
      title: '',
      description: null,
    }))
    expect(result.feasible).toBe(false)
    expect(result.blockers).toContainEqual(expect.stringContaining('No description'))
  })

  test('reduces confidence for short descriptions', () => {
    const detailed = assessTask(makeIssue())
    const short = assessTask(makeIssue({ description: 'Fix it' }))
    expect(short.confidence).toBeLessThan(detailed.confidence)
  })

  test('reduces confidence for non-automatable keywords', () => {
    const normal = assessTask(makeIssue())
    const research = assessTask(makeIssue({
      title: 'Research and discuss authentication approaches',
      description: 'We need to investigate different auth strategies and have a meeting to decide.',
    }))
    expect(research.confidence).toBeLessThan(normal.confidence)
  })

  test('keyword matching uses word boundaries to avoid false positives', () => {
    // "add" should not match inside "padding"/"address", "design" not inside "redesigned"
    const falsePositive = assessTask(makeIssue({
      title: 'Update padding on the redesigned file explorer card',
      description: 'The card component has incorrect padding after the latest redesigned layout was shipped.',
    }))
    // "design" and "explore" are NON_AUTOMATABLE — with substring matching they would
    // falsely match "redesigned" and "explorer", penalizing the task. With word-boundary
    // matching, only "update" (automatable) should match.
    expect(falsePositive.reasons).not.toContainEqual(expect.stringContaining('"design"'))
    expect(falsePositive.reasons).not.toContainEqual(expect.stringContaining('"explore"'))
  })

  test('boosts confidence for automatable keywords', () => {
    const vague = assessTask(makeIssue({
      title: 'Authentication flow',
      description: 'The authentication flow for the settings page needs attention. It should handle the OAuth redirect properly.',
    }))
    const specific = assessTask(makeIssue({
      title: 'Fix authentication bug in login flow',
      description: 'The authentication flow for the settings page needs attention. It should handle the OAuth redirect properly.',
    }))
    expect(specific.confidence).toBeGreaterThan(vague.confidence)
  })

  test('reduces confidence for high estimates', () => {
    const small = assessTask(makeIssue({ estimate: 2 }))
    const large = assessTask(makeIssue({ estimate: 8 }))
    expect(large.confidence).toBeLessThan(small.confidence)
  })

  test('reduces confidence for complex labels', () => {
    const normal = assessTask(makeIssue())
    const infra = assessTask(makeIssue({
      labels: { nodes: [{ name: 'infra' }] },
    }))
    expect(infra.confidence).toBeLessThan(normal.confidence)
  })

  test('boosts confidence for acceptance criteria', () => {
    const withCriteria = assessTask(makeIssue({
      description: 'Fix the login button.\n\n- [ ] Button responds to clicks\n- [ ] Auth flow opens\n- [x] Error state handled',
    }))
    const without = assessTask(makeIssue({
      description: 'Fix the login button. It does not work correctly.',
    }))
    expect(withCriteria.confidence).toBeGreaterThan(without.confidence)
  })

  test('boosts confidence for "Good For Bot" label', () => {
    const without = assessTask(makeIssue())
    const withLabel = assessTask(makeIssue({
      labels: { nodes: [{ name: 'Good For Bot' }] },
    }))
    expect(withLabel.confidence).toBeGreaterThan(without.confidence)
    expect(withLabel.reasons).toContainEqual(expect.stringContaining('priority label'))
  })

  test('matches priority labels case-insensitively', () => {
    const result = assessTask(makeIssue({
      labels: { nodes: [{ name: 'GOOD FOR BOT' }] },
    }))
    expect(result.reasons).toContainEqual(expect.stringContaining('priority label'))
  })

  test('clamps confidence to 0-100', () => {
    // Stack every positive signal to push confidence above 100
    const maxed = assessTask(makeIssue({
      estimate: 2,
      labels: { nodes: [{ name: 'Good For Bot' }] },
      description: 'Fix the broken login button.\n\n- [ ] Fix click handler\n- [ ] Add test\n- [x] Verify auth flow works correctly after the fix is applied',
    }))
    expect(maxed.confidence).toBeLessThanOrEqual(100)

    // Stack every negative signal to push confidence below 0
    const minimized = assessTask(makeIssue({
      estimate: 8,
      labels: { nodes: [{ name: 'infra' }, { name: 'devops' }] },
      title: 'Research and discuss and investigate and explore',
      description: 'x',
    }))
    expect(minimized.confidence).toBeGreaterThanOrEqual(0)
  })

  test('determines complexity from estimate', () => {
    expect(assessTask(makeIssue({ estimate: null, description: 'x' })).complexity).toBe('trivial')
    expect(assessTask(makeIssue({ estimate: 1 })).complexity).toBe('small')
    expect(assessTask(makeIssue({ estimate: 2 })).complexity).toBe('medium')
    expect(assessTask(makeIssue({ estimate: 5 })).complexity).toBe('large')
    expect(assessTask(makeIssue({ estimate: 8 })).complexity).toBe('too-large')
  })
})

describe('scoreTask', () => {
  test('returns -1 for infeasible tasks', () => {
    const result = scoreTask(makeIssue({
      children: { nodes: [{ id: 'child-1' }] },
    }))
    expect(result).toBe(-1)
  })

  test('scores higher priority tasks higher', () => {
    const urgent = scoreTask(makeIssue({ priority: 1 }))
    const low = scoreTask(makeIssue({ priority: 4 }))
    expect(urgent).toBeGreaterThan(low)
  })

  test('prefers small complexity over too-large', () => {
    const small = scoreTask(makeIssue({ estimate: 1 }))
    const tooLarge = scoreTask(makeIssue({ estimate: 8 }))
    // too-large may be infeasible due to confidence drop, but if feasible, small scores higher
    if (tooLarge !== -1) {
      expect(small).toBeGreaterThan(tooLarge)
    }
  })

  test('strongly boosts score for "Good For Bot" label', () => {
    const without = scoreTask(makeIssue())
    const withLabel = scoreTask(makeIssue({
      labels: { nodes: [{ name: 'Good For Bot' }] },
    }))
    expect(withLabel).toBeGreaterThan(without)
    // The label adds +50 in scoreTask plus up to +20 confidence (may be clamped at 100)
    expect(withLabel - without).toBeGreaterThanOrEqual(50)
  })

  test('well-described actionable tasks score highest', () => {
    const ideal = scoreTask(makeIssue({
      priority: 1,
      estimate: 2,
      title: 'Fix broken login button',
      description: 'The login button does not work.\n\n- [ ] Fix click handler\n- [ ] Add test',
    }))
    const vague = scoreTask(makeIssue({
      priority: 4,
      estimate: null,
      title: 'Something',
      description: 'Do it',
    }))
    expect(ideal).toBeGreaterThan(vague)
  })
})

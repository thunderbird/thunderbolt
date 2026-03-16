import { describe, expect, it } from 'bun:test'
import { filterActionableComments } from './cli/pr-comments'
import { SUBCOMMANDS } from './cli'

type MockComment = {
  id: number
  node_id: string
  body: string
  user: { login: string; type: string }
  created_at: string
  updated_at: string
}

const makeComment = (overrides: Partial<MockComment> = {}): MockComment => ({
  id: 1,
  node_id: 'IC_1',
  body: 'Please fix the null check on line 42',
  user: { login: 'reviewer', type: 'User' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
})

describe('filterActionableComments', () => {
  it('keeps regular user comments', () => {
    const comments = [makeComment({ body: 'This needs a fix' })]
    const result = filterActionableComments(comments)
    expect(result).toHaveLength(1)
    expect(result[0].body).toBe('This needs a fix')
  })

  it('excludes bot comments', () => {
    const comments = [
      makeComment({ user: { login: 'github-actions', type: 'Bot' }, body: 'CI passed' }),
      makeComment({ user: { login: 'reviewer', type: 'User' }, body: 'Looks good' }),
    ]
    const result = filterActionableComments(comments)
    expect(result).toHaveLength(1)
    expect(result[0].body).toBe('Looks good')
  })

  it('excludes thunderbot marker comments', () => {
    const comments = [
      makeComment({ body: '[Thunderbot] Starting automated work on this task.' }),
      makeComment({ body: 'Real feedback here' }),
    ]
    const result = filterActionableComments(comments)
    expect(result).toHaveLength(1)
    expect(result[0].body).toBe('Real feedback here')
  })

  it('excludes lightning-prefixed replies', () => {
    const comments = [
      makeComment({ body: '\u26a1 Done in the latest push.' }),
      makeComment({ body: 'Another comment' }),
    ]
    const result = filterActionableComments(comments)
    expect(result).toHaveLength(1)
    expect(result[0].body).toBe('Another comment')
  })

  it('handles mixed comments correctly', () => {
    const comments = [
      makeComment({ id: 1, body: '[Thunderbot] PR ready for review' }),
      makeComment({ id: 2, user: { login: 'bot', type: 'Bot' }, body: 'Automated check' }),
      makeComment({ id: 3, body: '\u26a1 Good call -- done.' }),
      makeComment({ id: 4, body: 'Please add tests for edge cases' }),
      makeComment({ id: 5, body: 'The naming convention here is off' }),
    ]
    const result = filterActionableComments(comments)
    expect(result).toHaveLength(2)
    expect(result.map((c) => c.id)).toEqual([4, 5])
  })

  it('returns empty array for no comments', () => {
    expect(filterActionableComments([])).toEqual([])
  })

  it('returns empty array when all comments are filtered out', () => {
    const comments = [
      makeComment({ user: { login: 'bot', type: 'Bot' }, body: 'test' }),
      makeComment({ body: '[Thunderbot] test' }),
      makeComment({ body: '\u26a1 test' }),
    ]
    expect(filterActionableComments(comments)).toEqual([])
  })
})

describe('CLI subcommand routing', () => {
  it('has all expected subcommands registered', () => {
    const expected = ['pr-threads', 'pr-reply', 'pr-comments', 'pr-minimize', 'ci-status', 'ci-logs']
    for (const name of expected) {
      expect(SUBCOMMANDS[name]).toBeDefined()
      expect(typeof SUBCOMMANDS[name].handler).toBe('function')
      expect(typeof SUBCOMMANDS[name].description).toBe('string')
    }
  })

  it('each subcommand has a non-empty description', () => {
    for (const [name, entry] of Object.entries(SUBCOMMANDS)) {
      expect(entry.description.length).toBeGreaterThan(0)
    }
  })
})

describe('argument parsing edge cases', () => {
  it('pr-threads handler throws on missing --pr', async () => {
    const { handlePRThreads } = await import('./cli/pr-threads')
    expect(handlePRThreads(['--unresolved'])).rejects.toThrow('Missing required argument: --pr')
  })

  it('pr-threads handler throws on non-numeric --pr', async () => {
    const { handlePRThreads } = await import('./cli/pr-threads')
    expect(handlePRThreads(['--pr', 'abc'])).rejects.toThrow('--pr must be a number')
  })

  it('pr-reply handler throws on missing --comment-id', async () => {
    const { handlePRReply } = await import('./cli/pr-threads')
    expect(handlePRReply(['--pr', '460', '--body', 'test'])).rejects.toThrow('Missing required argument: --comment-id')
  })

  it('pr-reply handler throws on missing --body', async () => {
    const { handlePRReply } = await import('./cli/pr-threads')
    expect(handlePRReply(['--pr', '460', '--comment-id', '123'])).rejects.toThrow('Missing required argument: --body')
  })

  it('ci-status handler throws on missing --pr', async () => {
    const { handleCIStatus } = await import('./cli/ci')
    expect(handleCIStatus([])).rejects.toThrow('Missing required argument: --pr')
  })

  it('pr-comments handler throws on missing --pr', async () => {
    const { handlePRComments } = await import('./cli/pr-comments')
    expect(handlePRComments(['--actionable'])).rejects.toThrow('Missing required argument: --pr')
  })

  it('pr-minimize handler throws on missing --pr', async () => {
    const { handlePRMinimize } = await import('./cli/pr-comments')
    expect(handlePRMinimize([])).rejects.toThrow('Missing required argument: --pr')
  })
})

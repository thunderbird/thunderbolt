/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check
const { describe, test, expect, mock, beforeEach, afterEach } = require('bun:test')
const fs = require('fs')
const path = require('path')
const postPrMetrics = require('./post-pr-metrics.cjs')

const BASELINE_DIR = '.metrics-baseline'
const BASELINE_FILE = `${BASELINE_DIR}/metrics.json`

/** @param {Partial<typeof process.env>} vars */
const withEnv = (vars) => {
  const original = {}
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key]
    if (vars[key] === undefined) delete process.env[key]
    else process.env[key] = vars[key]
  }
  return () => {
    for (const [key, val] of Object.entries(original)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  }
}

const makeGithub = ({ existingComment = null } = {}) => {
  const createComment = mock(() => Promise.resolve())
  const updateComment = mock(() => Promise.resolve())
  const listComments = mock(() =>
    Promise.resolve({ data: existingComment ? [existingComment] : [] })
  )
  return {
    rest: { issues: { listComments, createComment, updateComment } },
    _mocks: { createComment, updateComment, listComments },
  }
}

const makeContext = () => ({
  repo: { owner: 'thunderbird', repo: 'thunderbolt' },
  issue: { number: 456 },
  runId: 'run-1',
  runNumber: 1,
})

beforeEach(() => {
  if (!fs.existsSync(BASELINE_DIR)) fs.mkdirSync(BASELINE_DIR, { recursive: true })
})

afterEach(() => {
  if (fs.existsSync(BASELINE_FILE)) fs.rmSync(BASELINE_FILE)
  if (fs.existsSync(BASELINE_DIR)) fs.rmdirSync(BASELINE_DIR)
})

// ---------------------------------------------------------------------------
// Comment post vs update
// ---------------------------------------------------------------------------

describe('comment management', () => {
  test('creates a new comment when none exists', async () => {
    const restore = withEnv({ LINES_ADDED: '10', LINES_REMOVED: '2', BUILD_OUTCOME: 'success', PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    expect(gh._mocks.createComment).toHaveBeenCalledTimes(1)
    expect(gh._mocks.updateComment).not.toHaveBeenCalled()
    restore()
  })

  test('updates existing bot comment in place', async () => {
    const restore = withEnv({ LINES_ADDED: '5', LINES_REMOVED: '1', BUILD_OUTCOME: 'success', PREVIEW_READY: 'false' })
    const existing = { id: 99, user: { login: 'github-actions[bot]' }, body: '## PR Metrics\nold content' }
    const gh = makeGithub({ existingComment: existing })
    await postPrMetrics({ github: gh, context: makeContext() })
    expect(gh._mocks.updateComment).toHaveBeenCalledTimes(1)
    expect(gh._mocks.updateComment.mock.calls[0][0]).toMatchObject({ comment_id: 99 })
    expect(gh._mocks.createComment).not.toHaveBeenCalled()
    restore()
  })

  test('does not update a comment from a different user', async () => {
    const restore = withEnv({ LINES_ADDED: '5', LINES_REMOVED: '1', BUILD_OUTCOME: 'success', PREVIEW_READY: 'false' })
    const existing = { id: 88, user: { login: 'some-human' }, body: '## PR Metrics\nold' }
    const gh = makeGithub({ existingComment: existing })
    await postPrMetrics({ github: gh, context: makeContext() })
    expect(gh._mocks.createComment).toHaveBeenCalledTimes(1)
    expect(gh._mocks.updateComment).not.toHaveBeenCalled()
    restore()
  })

  test('does not update a comment with a different heading', async () => {
    const restore = withEnv({ LINES_ADDED: '5', LINES_REMOVED: '1', BUILD_OUTCOME: 'success', PREVIEW_READY: 'false' })
    const existing = { id: 77, user: { login: 'github-actions[bot]' }, body: '## Some Other Comment' }
    const gh = makeGithub({ existingComment: existing })
    await postPrMetrics({ github: gh, context: makeContext() })
    expect(gh._mocks.createComment).toHaveBeenCalledTimes(1)
    expect(gh._mocks.updateComment).not.toHaveBeenCalled()
    restore()
  })

  test('handles null user (deleted/ghost accounts) without throwing', async () => {
    const restore = withEnv({ LINES_ADDED: '1', LINES_REMOVED: '0', BUILD_OUTCOME: 'success', PREVIEW_READY: 'false' })
    const ghost = { id: 55, user: null, body: '## PR Metrics\nold' }
    const gh = makeGithub({ existingComment: ghost })
    await expect(postPrMetrics({ github: gh, context: makeContext() })).resolves.toBeUndefined()
    restore()
  })
})

// ---------------------------------------------------------------------------
// Bundle size section
// ---------------------------------------------------------------------------

describe('bundle size', () => {
  test('shows build failed message when BUILD_OUTCOME is not success', async () => {
    const restore = withEnv({ BUILD_OUTCOME: 'failure', BUNDLE_GZIP: '500000', PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain('_Build failed_')
    restore()
  })

  test('shows dash when bundle size is zero', async () => {
    const restore = withEnv({ BUILD_OUTCOME: 'success', BUNDLE_GZIP: '0', PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain('| JS bundle size (gzipped) | — |')
    restore()
  })

  test('shows no-baseline message when baseline file is absent', async () => {
    const restore = withEnv({ BUILD_OUTCOME: 'success', BUNDLE_GZIP: '204800', PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain('no baseline yet')
    restore()
  })

  test('shows green circle when bundle grows <= 10 KB', async () => {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ bundleSize: 200000, coverage: '80' }))
    const restore = withEnv({ BUILD_OUTCOME: 'success', BUNDLE_GZIP: String(200000 + 5120), PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain(':green_circle:')
    restore()
  })

  test('shows yellow circle when bundle grows between 10 KB and 50 KB', async () => {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ bundleSize: 200000, coverage: '80' }))
    const restore = withEnv({ BUILD_OUTCOME: 'success', BUNDLE_GZIP: String(200000 + 20480), PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain(':yellow_circle:')
    restore()
  })

  test('shows red circle when bundle grows > 50 KB', async () => {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ bundleSize: 200000, coverage: '80' }))
    const restore = withEnv({ BUILD_OUTCOME: 'success', BUNDLE_GZIP: String(200000 + 102400), PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain(':red_circle:')
    restore()
  })

  test('shows green circle when bundle shrinks', async () => {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ bundleSize: 200000, coverage: '80' }))
    const restore = withEnv({ BUILD_OUTCOME: 'success', BUNDLE_GZIP: String(200000 - 10000), PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain(':green_circle:')
    expect(body).toContain('-9.8 KB')
    restore()
  })

  test('shows 0 B delta when bundle size is unchanged', async () => {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ bundleSize: 200000, coverage: '80' }))
    const restore = withEnv({ BUILD_OUTCOME: 'success', BUNDLE_GZIP: '200000', PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain('0 B')
    restore()
  })
})

// ---------------------------------------------------------------------------
// Coverage section
// ---------------------------------------------------------------------------

describe('test coverage', () => {
  test('shows dash when COVERAGE is missing', async () => {
    const restore = withEnv({ BUILD_OUTCOME: 'success', COVERAGE: undefined, PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain('| Test coverage | — |')
    restore()
  })

  test('shows dash when COVERAGE is N/A', async () => {
    const restore = withEnv({ BUILD_OUTCOME: 'success', COVERAGE: 'N/A', PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain('| Test coverage | — |')
    restore()
  })

  test('shows no-baseline message when baseline file is absent', async () => {
    const restore = withEnv({ BUILD_OUTCOME: 'success', COVERAGE: '82.5', PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain('no baseline yet')
    restore()
  })

  test('shows no-baseline message when baseline coverage is N/A (NaN guard)', async () => {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ bundleSize: 200000, coverage: 'N/A' }))
    const restore = withEnv({ BUILD_OUTCOME: 'success', COVERAGE: '82.5', PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain('no baseline yet')
    restore()
  })

  test('shows green circle when coverage improves', async () => {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ bundleSize: 200000, coverage: '80.0' }))
    const restore = withEnv({ BUILD_OUTCOME: 'success', COVERAGE: '82.5', PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain(':green_circle:')
    expect(body).toContain('+2.5%')
    restore()
  })

  test('shows yellow circle when coverage drops <= 2%', async () => {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ bundleSize: 200000, coverage: '80.0' }))
    const restore = withEnv({ BUILD_OUTCOME: 'success', COVERAGE: '79.0', PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain(':yellow_circle:')
    restore()
  })

  test('shows red circle when coverage drops > 2%', async () => {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ bundleSize: 200000, coverage: '80.0' }))
    const restore = withEnv({ BUILD_OUTCOME: 'success', COVERAGE: '77.0', PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain(':red_circle:')
    restore()
  })
})

// ---------------------------------------------------------------------------
// Lighthouse section
// ---------------------------------------------------------------------------

describe('lighthouse', () => {
  test('shows preview not ready message when PREVIEW_READY is not true', async () => {
    const restore = withEnv({ BUILD_OUTCOME: 'success', PREVIEW_READY: 'false' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain('_Preview not ready')
    restore()
  })

  test('shows unavailable message when LH_PERF is missing', async () => {
    const restore = withEnv({ BUILD_OUTCOME: 'success', PREVIEW_READY: 'true', LH_PERF: undefined, LH_FCP: '1.2 s', LH_LCP: '2.3 s', LH_TBT: '50 ms' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain('_Lighthouse results unavailable_')
    restore()
  })

  test('shows unavailable message when any timing metric is missing', async () => {
    const restore = withEnv({ BUILD_OUTCOME: 'success', PREVIEW_READY: 'true', LH_PERF: '85', LH_FCP: '1.2 s', LH_LCP: undefined, LH_TBT: '50 ms' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain('_Lighthouse results unavailable_')
    restore()
  })

  test('shows green circle for perf score >= 90', async () => {
    const restore = withEnv({ BUILD_OUTCOME: 'success', PREVIEW_READY: 'true', LH_PERF: '95', LH_FCP: '0.8 s', LH_LCP: '1.2 s', LH_TBT: '10 ms' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain(':green_circle:')
    expect(body).toContain('**95/100**')
    restore()
  })

  test('shows yellow circle for perf score between 50 and 89', async () => {
    const restore = withEnv({ BUILD_OUTCOME: 'success', PREVIEW_READY: 'true', LH_PERF: '72', LH_FCP: '2.1 s', LH_LCP: '3.5 s', LH_TBT: '200 ms' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain(':yellow_circle:')
    restore()
  })

  test('shows red circle for perf score below 50', async () => {
    const restore = withEnv({ BUILD_OUTCOME: 'success', PREVIEW_READY: 'true', LH_PERF: '32', LH_FCP: '5.0 s', LH_LCP: '8.0 s', LH_TBT: '1200 ms' })
    const gh = makeGithub()
    await postPrMetrics({ github: gh, context: makeContext() })
    const body = gh._mocks.createComment.mock.calls[0][0].body
    expect(body).toContain(':red_circle:')
    restore()
  })
})

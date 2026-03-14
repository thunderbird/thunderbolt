// @ts-check

/**
 * Posts or updates the PR Metrics comment on a pull request.
 * Runs via actions/github-script — receives `github`, `context`, and `process.env`.
 *
 * @param {import('@actions/github').GitHub} github
 * @param {import('@actions/github').context} context
 */
module.exports = async ({ github, context }) => {
  const fs = require('fs')

  // All metric values are passed in as environment variables by the workflow.
  // The workflow captures them from individual step outputs.
  const { LINES_ADDED, LINES_REMOVED, BUNDLE_GZIP, COVERAGE, BUILD_OUTCOME,
          PREVIEW_URL, PREVIEW_READY, LH_PERF, LH_FCP, LH_LCP, LH_TBT } = process.env

  // BUNDLE_GZIP is the gzipped JS bundle size in bytes — what users actually download.
  // Measured by size-limit, which is more accurate than summing raw file sizes.
  const bundleSize = parseInt(BUNDLE_GZIP ?? '0') || 0
  const buildFailed = BUILD_OUTCOME !== 'success'

  // The baseline is saved by ci.yml after every merge to main.
  // It contains the bundle size and coverage % from the last main build,
  // which lets us show a delta instead of just an absolute value.
  let baselineBundle = null
  let baselineCoverage = null
  try {
    if (fs.existsSync('.metrics-baseline/metrics.json')) {
      const baseline = JSON.parse(fs.readFileSync('.metrics-baseline/metrics.json', 'utf8'))
      baselineBundle = baseline.bundleSize
      baselineCoverage = baseline.coverage
    }
  } catch (_) {}

  // Converts a raw byte count into a human-readable string (B / KB / MB).
  const fmt = (bytes) => {
    if (!bytes) return 'N/A'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }

  // Builds the bundle size cell for the markdown table.
  // - Red if grown by more than 50 KB, yellow above 10 KB, green otherwise.
  // - Falls back gracefully when the build failed or no baseline exists yet.
  const bundleLine = (() => {
    if (buildFailed) return '_Build failed_'
    if (!bundleSize) return '—'
    if (baselineBundle != null && baselineBundle > 0) {
      const delta = bundleSize - baselineBundle
      const pct = ((delta / baselineBundle) * 100).toFixed(1)
      // Use explicit +/- prefix on both the byte and percentage portions so
      // a shrinking bundle shows "-5.0 KB, -5.0%" rather than "5.0 KB, -5.0%".
      const bytesDelta = `${delta >= 0 ? '+' : '-'}${fmt(Math.abs(delta))}`
      const pctDelta = `${delta >= 0 ? '+' : ''}${pct}%`
      const icon = delta > 51200 ? ':red_circle:' : delta > 10240 ? ':yellow_circle:' : ':green_circle:'
      return `${icon} ${fmt(baselineBundle)} → ${fmt(bundleSize)} (${bytesDelta}, ${pctDelta})`
    }
    return `${fmt(bundleSize)} _(no baseline yet — merge to main first)_`
  })()

  // Builds the test coverage cell for the markdown table.
  // - Red if coverage dropped more than 2%, yellow if any drop, green otherwise.
  // - Falls back gracefully when coverage couldn't be parsed or no baseline exists yet.
  // Guard against baselineCoverage being "N/A" (written by ci.yml when coverage
  // parsing fails on main) — it's truthy but produces NaN when passed to parseFloat.
  const baselineCoverageParsed = parseFloat(baselineCoverage ?? '')
  const coverageLine = (() => {
    if (!COVERAGE || COVERAGE === 'N/A') return '—'
    if (!isNaN(baselineCoverageParsed)) {
      const delta = (parseFloat(COVERAGE) - baselineCoverageParsed).toFixed(1)
      const sign = parseFloat(delta) >= 0 ? '+' : ''
      const icon =
        parseFloat(delta) < -2 ? ':red_circle:' : parseFloat(delta) < 0 ? ':yellow_circle:' : ':green_circle:'
      return `${icon} ${baselineCoverage}% → ${COVERAGE}% (${sign}${delta}%)`
    }
    return `${COVERAGE}% _(no baseline yet — merge to main first)_`
  })()

  // Builds the load time cell using Lighthouse metrics from the Render PR preview.
  // Shows performance score + the three key timing metrics:
  // - FCP: when something first appears on screen
  // - LCP: when the main content appears (best proxy for "spinner gone")
  // - TBT: total blocking time (proxy for interactivity)
  // Falls back gracefully when the preview wasn't ready or Lighthouse failed.
  const lighthouseLine = (() => {
    if (PREVIEW_READY !== 'true') return '_Preview not ready — Render deploy may have timed out_'
    if (!LH_PERF) return '_Lighthouse did not run_'
    const perfScore = parseInt(LH_PERF)
    const icon = perfScore >= 90 ? ':green_circle:' : perfScore >= 50 ? ':yellow_circle:' : ':red_circle:'
    return `${icon} **${perfScore}/100** · First Contentful Paint ${LH_FCP} · Largest Contentful Paint ${LH_LCP} · Total Blocking Time ${LH_TBT}`
  })()

  const runUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`
  const now = new Date().toUTCString()

  const body = [
    '## PR Metrics',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Lines changed (prod code) | \`+${LINES_ADDED || 0} / -${LINES_REMOVED || 0}\` |`,
    `| JS bundle size (gzipped) | ${bundleLine} |`,
    `| Test coverage | ${coverageLine} |`,
    `| Load time ([preview](${PREVIEW_URL})) | ${lighthouseLine} |`,
    '',
    `_Updated ${now} · [run #${context.runNumber}](${runUrl})_`,
  ].join('\n')

  // Look for a previous metrics comment from the Actions bot so we can
  // update it in place rather than posting a new comment on every push.
  const { data: comments } = await github.rest.issues.listComments({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
  })

  const existing = comments.find((c) => c.user.login === 'github-actions[bot]' && c.body.startsWith('## PR Metrics'))

  if (existing) {
    await github.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existing.id,
      body,
    })
  } else {
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.issue.number,
      body,
    })
  }
}

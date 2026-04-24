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
          PREVIEW_URL, PREVIEW_READY, LH_PERF, LH_A11Y, LH_BP, LH_SEO,
          LH_FCP, LH_LCP, LH_TBT, LH_CLS, LH_REPORT_URL, LH_WARNINGS } = process.env

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
      // Special-case zero to avoid fmt(0) returning 'N/A' (fmt treats 0 as falsy).
      const bytesDelta = delta === 0 ? '0 B' : `${delta >= 0 ? '+' : '-'}${fmt(Math.abs(delta))}`
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

  // Builds the Lighthouse section using metrics from the Render PR preview.
  // Shows category scores + key web vitals, with an optional link to the full report.
  // Falls back gracefully when the preview wasn't ready or Lighthouse failed.
  const scoreIcon = (score) => score >= 90 ? ':green_circle:' : score >= 50 ? ':yellow_circle:' : ':red_circle:'

  const lighthouseLine = (() => {
    if (PREVIEW_READY !== 'true') return '_Preview not ready — Render deploy may have timed out_'
    const perfScore = parseInt(LH_PERF)
    if (isNaN(perfScore) || !LH_FCP || !LH_LCP || !LH_TBT) return '_Lighthouse results unavailable_'
    const reportLink = LH_REPORT_URL ? ` · [Full report](${LH_REPORT_URL})` : ''
    return `${scoreIcon(perfScore)} **${perfScore}/100** · FCP ${LH_FCP} · LCP ${LH_LCP} · TBT ${LH_TBT} · CLS ${LH_CLS || 'N/A'}${reportLink}`
  })()

  const a11yScore = parseInt(LH_A11Y)
  const a11yLine = isNaN(a11yScore) ? '—' : `${scoreIcon(a11yScore)} **${a11yScore}/100**`
  const bpScore = parseInt(LH_BP)
  const bpLine = isNaN(bpScore) ? '—' : `${scoreIcon(bpScore)} **${bpScore}/100**`
  const seoScore = parseInt(LH_SEO)
  const seoLine = isNaN(seoScore) ? '—' : `${scoreIcon(seoScore)} **${seoScore}/100**`

  const runUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`
  const now = new Date().toUTCString()

  const lines = [
    '## PR Metrics',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Lines changed (prod code) | \`+${LINES_ADDED || 0} / -${LINES_REMOVED || 0}\` |`,
    `| JS bundle size (gzipped) | ${bundleLine} |`,
    `| Test coverage | ${coverageLine} |`,
    `| Performance ([preview](${PREVIEW_URL})) | ${lighthouseLine} |`,
    `| Accessibility | ${a11yLine} |`,
    `| Best Practices | ${bpLine} |`,
    `| SEO | ${seoLine} |`,
  ]

  // Show LHCI assertion warnings in a collapsible section so reviewers
  // can see what's below threshold without digging into CI logs.
  const warnings = (LH_WARNINGS || '').trim()
  if (warnings) {
    lines.push(
      '',
      '<details>',
      '<summary>:warning: Lighthouse warnings</summary>',
      '',
      '```',
      warnings,
      '```',
      '',
      '</details>',
    )
  }

  lines.push(
    '',
    `_Updated ${now} · [run #${context.runNumber}](${runUrl})_`,
  )

  const body = lines.join('\n')

  // Look for a previous metrics comment from the Actions bot so we can
  // update it in place rather than posting a new comment on every push.
  const { data: comments } = await github.rest.issues.listComments({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
  })

  // c.user is null for comments from deleted ("ghost") accounts — guard with optional chaining.
  const existing = comments.find((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith('## PR Metrics'))

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

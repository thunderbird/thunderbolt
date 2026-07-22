const fs = require("fs")
const path = require("path")

const BASELINE_FILE = path.join(".metrics-baseline", "metrics.json")
const COMMENT_TAG = "<!-- pr-metrics -->"

// ---------- helpers ----------

function readNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function readCoverage(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null
}

function safeReadBaseline() {
  try {
    if (!fs.existsSync(BASELINE_FILE)) return null
    const raw = fs.readFileSync(BASELINE_FILE, "utf8")
    return JSON.parse(raw)
  } catch {
    return null // corrupted file safe fallback
  }
}

function formatBytes(bytes) {
  if (bytes == null) return "—"
  return `${(bytes / 1024).toFixed(1)} KB`
}

function diffText(current, baseline, formatter = v => v) {
  if (current == null) return "—"
  if (!baseline) return formatter(current)

  const diff = current - baseline
  if (diff === 0) return `${formatter(current)} (no change)`

  const sign = diff > 0 ? "▲" : "▼"
  return `${formatter(current)} (${sign} ${formatter(Math.abs(diff))})`
}

function buildComment({ bundle, baselineBundle, coverage, baselineCoverage }) {
  const bundleRow = diffText(bundle, baselineBundle, formatBytes)
  const coverageRow = diffText(coverage, baselineCoverage, v => `${v.toFixed(1)}%`)

  return `${COMMENT_TAG}
## 📊 PR Metrics

| Metric | Value |
|---|---|
| Bundle size (gzip) | ${bundleRow} |
| Test coverage | ${coverageRow} |
`
}

// ---------- main function ----------

async function postPrMetrics({ github, context }) {
  // Skip conditions
  if (process.env.BUILD_OUTCOME !== "success") return
  if (process.env.PREVIEW_READY !== "true" && process.env.PREVIEW_READY !== "false") return

  const bundle = readNumber(process.env.BUNDLE_GZIP)
  const coverage = readCoverage(process.env.COVERAGE)

  const baseline = safeReadBaseline()
  const baselineBundle = baseline?.bundleSize ?? null
  const baselineCoverage = readCoverage(baseline?.coverage)

  const body = buildComment({
    bundle,
    baselineBundle,
    coverage,
    baselineCoverage,
  })

  const { owner, repo } = context.repo
  const issue_number = context.issue.number

  const comments = await github.rest.issues.listComments({
    owner,
    repo,
    issue_number,
  })

  const existing = comments.data.find(c => c.body?.includes(COMMENT_TAG))

  if (existing) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    })
  } else {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number,
      body,
    })
  }
}

module.exports = { postPrMetrics }

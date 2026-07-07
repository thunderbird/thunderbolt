#!/usr/bin/env bun
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Turns a RunReport into ranked candidate Findings by applying fixed
 * thresholds, then renders a compact markdown summary. Thresholds are
 * intentionally conservative (favor recall); the adversarial Verify phase in
 * SKILL.md is responsible for precision. Run standalone to re-summarize:
 *   bun scripts/report.ts .perf-hunt/runs/<id>/report.json
 */

import { readFileSync, writeFileSync } from 'node:fs'
import type { Finding, RunReport, ScenarioReport, Severity } from './lib/types'
import { applyExclusions, loadCalibration } from './lib/calibration'

const NOISE_RENDER_MIN_COMMITS = 3
const LONG_TASK_MS = 120
const LOAF_MS = 200
const FORCED_LAYOUT_MS = 30
const HEAP_LEAK_BYTES = 3_000_000
const BIG_ASSET_BYTES = 1_000_000

const sev = (rating: string): Severity =>
  rating === 'poor' ? 'high' : rating === 'needs-improvement' ? 'medium' : 'low'

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60)

/** Deterministic first-pass candidates. Recall-biased; verify downstream. */
export const deriveCandidates = (report: RunReport): Finding[] => {
  const out: Finding[] = []
  const push = (f: Omit<Finding, 'status'>) => out.push({ ...f, status: 'candidate' })

  for (const r of report.scenarios) {
    const where = `${r.scenario}/${r.browser}`

    for (const v of r.vitals) {
      if (v.rating === 'good') continue
      push({
        id: slug(`vital-${v.name}-${where}`),
        category: 'web-vital',
        title: `${v.name} ${v.rating} on ${r.scenario} (${r.browser})`,
        severity: sev(v.rating),
        confidence: 'high',
        browsers: [r.browser],
        scenarios: [r.scenario],
        evidence: `${v.name}=${v.value}${v.name === 'CLS' ? '' : 'ms'} (${v.rating})`,
        sourceAttribution: v.attribution,
        repro: `bun scripts/run.ts --mode focus --focus ${r.scenario} --browsers ${r.browser}`,
      })
    }

    for (const rnd of r.noiseRenders) {
      if (rnd.commits < NOISE_RENDER_MIN_COMMITS) continue
      push({
        id: slug(`rerender-${rnd.component}-${where}`),
        category: 'unnecessary-render',
        title: `<${rnd.component}> re-renders ${rnd.commits}x during unrelated interaction (${r.scenario}/${r.browser})`,
        severity: rnd.commits >= 8 ? 'high' : 'medium',
        confidence: 'medium',
        browsers: [r.browser],
        scenarios: [r.scenario],
        evidence: `${rnd.commits} commits, ${rnd.totalDuration}ms subtree render during a no-op interaction`,
        sourceAttribution: rnd.component,
        repro: `bun scripts/run.ts --mode focus --focus ${r.scenario} --browsers ${r.browser} (inspect noiseRenders)`,
        suggestedFix: 'Check for unstable props/context or missing memoization; see references/react-rerender-playbook.md',
      })
    }

    for (const f of r.loaf) {
      if (f.duration < LOAF_MS && f.forcedStyleAndLayoutDuration < FORCED_LAYOUT_MS) continue
      const worst = [...f.scripts].sort((a, b) => b.duration - a.duration)[0]
      const thrash = f.forcedStyleAndLayoutDuration >= FORCED_LAYOUT_MS
      push({
        id: slug(`${thrash ? 'thrash' : 'loaf'}-${worst?.sourceFunctionName || 'anon'}-${where}`),
        category: thrash ? 'layout-thrash' : 'long-task',
        title: `${thrash ? 'Layout thrash' : 'Long animation frame'} ${Math.round(f.duration)}ms on ${r.scenario} (${r.browser})`,
        severity: f.duration >= 400 ? 'high' : 'medium',
        confidence: 'high',
        browsers: [r.browser],
        scenarios: [r.scenario],
        evidence: `LoAF ${Math.round(f.duration)}ms, blocking ${Math.round(f.blockingDuration)}ms, forced layout ${Math.round(f.forcedStyleAndLayoutDuration)}ms`,
        sourceAttribution: worst ? `${worst.sourceURL}:${worst.sourceCharPosition} ${worst.sourceFunctionName}` : undefined,
        repro: `bun scripts/run.ts --mode focus --focus ${r.scenario} --browsers ${r.browser}`,
      })
    }

    for (const lt of r.longTasks.filter((t) => t.duration >= LONG_TASK_MS).slice(0, 3)) {
      push({
        id: slug(`longtask-${lt.attribution}-${where}-${Math.round(lt.startTime)}`),
        category: 'long-task',
        title: `Long task ${Math.round(lt.duration)}ms on ${r.scenario} (${r.browser})`,
        severity: lt.duration >= 300 ? 'high' : 'medium',
        confidence: 'medium',
        browsers: [r.browser],
        scenarios: [r.scenario],
        evidence: `${Math.round(lt.duration)}ms task, attribution=${lt.attribution}`,
        repro: `bun scripts/run.ts --mode focus --focus ${r.scenario} --browsers ${r.browser}`,
      })
    }

    for (const h of r.heap) {
      // The byte delta is the real leak signal; the DOM-node delta is only
      // context (live node counts fluctuate, so >0 alone over-reports).
      if (h.deltaBytes < HEAP_LEAK_BYTES) continue
      push({
        id: slug(`leak-${h.label}-${where}`),
        category: 'memory-leak',
        title: `Possible memory leak: +${(h.deltaBytes / 1e6).toFixed(1)}MB after ${h.label} (${r.browser})`,
        severity: 'high',
        confidence: 'low',
        browsers: [r.browser],
        scenarios: [r.scenario],
        evidence: `heap ${(h.beforeBytes / 1e6).toFixed(1)}→${(h.afterBytes / 1e6).toFixed(1)}MB, DOM nodes Δ=${h.domNodesDelta ?? 'n/a'}`,
        repro: `bun scripts/run.ts --mode focus --focus ${r.scenario} --browsers chromium (heap delta)`,
      })
    }

    for (const err of r.pageErrors.slice(0, 5)) {
      push({
        id: slug(`crash-${err}-${where}`),
        category: 'crash',
        title: `Uncaught error on ${r.scenario} (${r.browser})`,
        severity: 'critical',
        confidence: 'high',
        browsers: [r.browser],
        scenarios: [r.scenario],
        evidence: err,
        repro: `bun scripts/run.ts --mode focus --focus ${r.scenario} --browsers ${r.browser}`,
      })
    }

    for (const c of r.console.filter((c) => c.level === 'error').slice(0, 5)) {
      push({
        id: slug(`console-${c.text}-${where}`),
        category: 'console-error',
        title: `Console error on ${r.scenario} (${r.browser})`,
        severity: 'medium',
        confidence: 'medium',
        browsers: [r.browser],
        scenarios: [r.scenario],
        evidence: c.text,
        sourceAttribution: c.location,
        repro: `bun scripts/run.ts --mode focus --focus ${r.scenario} --browsers ${r.browser}`,
      })
    }

    for (const a of r.a11y.filter((v) => v.impact === 'critical' || v.impact === 'serious').slice(0, 8)) {
      push({
        id: slug(`a11y-${a.ruleId}-${where}`),
        category: 'a11y',
        title: `a11y: ${a.ruleId} (${a.impact}) on ${r.scenario}`,
        severity: a.impact === 'critical' ? 'high' : 'medium',
        confidence: 'high',
        browsers: [r.browser],
        scenarios: [r.scenario],
        evidence: `${a.help} — ${a.selectors.slice(0, 3).join(', ')}`,
        sourceAttribution: a.selectors[0],
        repro: `bun scripts/run.ts --mode focus --focus ${r.scenario} --browsers ${r.browser}`,
      })
    }

    // NOTE: script transfer sizes over the DEV server are Vite pre-bundles
    // (node_modules/.vite/deps/*), not production chunks — so bundle findings
    // come exclusively from analyze-bundle.ts (which builds prod), never from
    // dev network sizes. Here we only flag network issues that ARE real in dev:
    // server errors and oversized non-script assets (images/fonts/media).
    for (const n of r.network.filter((n) => n.status >= 500 || n.status === 0).slice(0, 5)) {
      push({
        id: slug(`neterr-${n.url}-${where}`),
        category: 'network',
        title: `Failed request (${n.status || 'no response'}) on ${r.scenario} (${r.browser})`,
        severity: 'high',
        confidence: 'high',
        browsers: [r.browser],
        scenarios: [r.scenario],
        evidence: `${n.method} ${n.url} → ${n.status || 'network error'}`,
        sourceAttribution: n.url,
        repro: `bun scripts/run.ts --mode focus --focus ${r.scenario} --browsers ${r.browser}`,
      })
    }
    const bigAsset = r.network.filter(
      (n) => n.resourceType !== 'script' && n.resourceType !== 'document' && n.transferSizeBytes >= BIG_ASSET_BYTES,
    )
    for (const n of bigAsset.slice(0, 3)) {
      push({
        id: slug(`asset-${n.url}-${where}`),
        category: 'network',
        title: `Large ${n.resourceType} asset ${(n.transferSizeBytes / 1024).toFixed(0)}KB on ${r.scenario}`,
        severity: 'medium',
        confidence: 'high',
        browsers: [r.browser],
        scenarios: [r.scenario],
        evidence: `${n.url} = ${(n.transferSizeBytes / 1024).toFixed(0)}KB (${n.resourceType})`,
        sourceAttribution: n.url,
        repro: `bun scripts/run.ts --mode focus --focus ${r.scenario} --browsers ${r.browser}`,
      })
    }
  }

  const merged = mergeAcrossBrowsers(out)
  const cal = loadCalibration()
  const kept = applyExclusions(merged, cal)
  if (kept.length < merged.length) {
    console.error(`perf-hunt: suppressed ${merged.length - kept.length} finding(s) via ${cal.excludeSignatures.length} learned exclusion(s)`)
  }
  return kept
}

/** Collapse the same issue seen in both browsers into one finding. */
const mergeAcrossBrowsers = (findings: Finding[]): Finding[] => {
  const byKey = new Map<string, Finding>()
  for (const f of findings) {
    const key = `${f.category}::${f.sourceAttribution ?? f.title.replace(/\(.*?\)/g, '')}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, f)
      continue
    }
    existing.browsers = [...new Set([...existing.browsers, ...f.browsers])]
    existing.scenarios = [...new Set([...existing.scenarios, ...f.scenarios])]
  }
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }
  return [...byKey.values()].sort((a, b) => order[a.severity] - order[b.severity])
}

const perfLine = (r: ScenarioReport): string => {
  const v = (n: string) => r.vitals.find((x) => x.name === n)
  const lcp = v('LCP')
  const inp = v('INP')
  const cls = v('CLS')
  const noisy = r.noiseRenders.filter((x) => x.commits >= NOISE_RENDER_MIN_COMMITS).length
  return `| ${r.scenario} | ${r.browser} | ${lcp ? lcp.value + 'ms' : '—'} | ${inp ? inp.value + 'ms' : '—'} | ${cls ? cls.value : '—'} | ${r.longTasks.length} | ${noisy} | ${r.console.filter((c) => c.level === 'error').length} | ${r.a11y.length} |`
}

export const summarize = (report: RunReport, findings: Finding[]): string => {
  const bySev = (s: Severity) => findings.filter((f) => f.severity === s).length
  const lines = [
    `# perf-hunt report — ${report.runId}`,
    ``,
    `Mode: **${report.mode}** · git \`${report.gitRef}\` · ${report.scenarios.length} scenario runs`,
    `Findings: **${findings.length}** — 🔴 ${bySev('critical')} critical · 🟠 ${bySev('high')} high · 🟡 ${bySev('medium')} medium · ⚪ ${bySev('low')} low`,
    ``,
    `## Per-scenario metrics`,
    ``,
    `| scenario | browser | LCP | INP | CLS | long tasks | noisy renders | console errs | a11y |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...report.scenarios.map(perfLine),
    ``,
    `## Candidate findings (recall-biased — verify before fixing)`,
    ``,
    ...findings.map(
      (f, i) =>
        `${i + 1}. **[${f.severity}/${f.category}]** ${f.title}\n   - evidence: ${f.evidence}\n   - source: ${f.sourceAttribution ?? '(needs attribution)'}\n   - repro: \`${f.repro}\``,
    ),
  ]
  return lines.join('\n')
}

if (import.meta.main) {
  const path = process.argv[2]
  if (!path) throw new Error('usage: bun scripts/report.ts <report.json>')
  const report = JSON.parse(readFileSync(path, 'utf8')) as RunReport
  const findings = deriveCandidates(report)
  const dir = path.replace(/\/report\.json$/, '')
  writeFileSync(`${dir}/findings.json`, JSON.stringify(findings, null, 2))
  writeFileSync(`${dir}/summary.md`, summarize(report, findings))
  console.log(`${dir}/summary.md`)
}

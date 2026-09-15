/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto'
import type {
  EvalAcceptance,
  EvalManifest,
  EvalMetrics,
  EvalMetricsGroup,
  EvalScenario,
  EvalScenarioMetrics,
  EvalTrial,
  NecessityCategory,
  NecessityCategoryMetrics,
  NecessityRateMetric,
  ScenarioInterval,
} from './types'

export const categoryGateThresholds: Record<NecessityCategory, number> = {
  never_search: 0.95,
  answer_then_offer: 0.8,
  single_search: 0.9,
  research: 0.85,
  unknown_entity: 0.85,
  false_premise: 0.75,
  adversarial_no_search: 0.9,
  multi_turn_reuse: 0.9,
  search_wont_help: 0.6,
  // Following an explicit instruction about output language is close to
  // deterministic for a capable model, so this gates as tightly as never_search.
  language: 0.95,
}

const settingAllowlist = [
  'EVAL_MODELS',
  'EVAL_ENGINES',
  'EVAL_MODES',
  'EVAL_SUITES',
  'EVAL_SAMPLES',
  'EVAL_TIMEOUT',
  'EVAL_JUDGE_TIMEOUT',
  'EVAL_SCENARIO_PARALLEL',
  'EVAL_SMOKE',
  'EVAL_LANGUAGE',
  'EVAL_NECESSITY_OPTIONAL',
  'WEB_BUDGET_PROMOTION',
] as const

/** Reject invalid deadlines before executing any work. */
export const positiveFinite = (value: string | undefined, fallback: number, name: string): number => {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive finite number`)
  }
  return number
}

/** Redact credential keys, bearer values and the run's known secrets at every artifact boundary. */
export const serializeArtifact = (
  value: unknown,
  secrets: readonly string[] = [process.env.EVAL_AUTH_TOKEN ?? ''],
  space?: number,
): string => {
  const credentials = [...secrets]
  const serialized = JSON.stringify(
    value,
    (key, item: unknown) => {
      if (/token|authorization|cookie|api[-_]?key|password|secret/i.test(key)) {
        if (typeof item === 'string' && item) {
          credentials.push(item)
        }
        return '[REDACTED]'
      }
      if (typeof item !== 'string') {
        return item
      }
      // Header diagnostics may contain cookie attributes or comma-separated auth parameters.
      // Redact through the line end (including folded continuation lines), regardless of scheme.
      return item
        .replace(/\b(authorization|(?:set-)?cookie)["']?\s*[:=]\s*[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi, '$1: [REDACTED]')
        .replace(/Bearer\s+[^\s";,]+/gi, 'Bearer [REDACTED]')
    },
    space,
  )
  return credentials
    .filter(Boolean)
    .reduce((text, secret) => text.replaceAll(JSON.stringify(secret).slice(1, -1), '[REDACTED]'), serialized)
}

/** Snapshot the selected matrix before execution; settings come only from the allowlist. */
export const createManifest = (
  scenarios: EvalScenario[],
  metadata: Omit<
    EvalManifest,
    'scenarios' | 'settings' | 'rubricHash' | 'auth' | 'partial' | 'smoke' | 'timeout' | 'judgeTimeout'
  >,
  environment: Record<string, string | undefined> = {},
): EvalManifest => {
  const smoke = environment.EVAL_SMOKE === '1'
  const manifest: EvalManifest = {
    ...metadata,
    scenarios: scenarios.map((scenario) => ({ scenario, planned: scenario.category && !smoke ? metadata.samples : 1 })),
    settings: Object.fromEntries(
      settingAllowlist.flatMap((key) => (environment[key] === undefined ? [] : [[key, environment[key]]])),
    ),
    rubricHash: createHash('sha256').update(JSON.stringify(scenarios)).digest('hex'),
    auth: environment.EVAL_AUTH_TOKEN ? 'present' : 'absent',
    partial:
      smoke || ['EVAL_MODELS', 'EVAL_SUITES', 'EVAL_ENGINES', 'EVAL_MODES'].some((key) => Boolean(environment[key])),
    smoke,
    timeout: positiveFinite(environment.EVAL_TIMEOUT, 600000, 'EVAL_TIMEOUT'),
    judgeTimeout: positiveFinite(environment.EVAL_JUDGE_TIMEOUT, 60000, 'EVAL_JUDGE_TIMEOUT'),
  }
  return JSON.parse(serializeArtifact(manifest, [environment.EVAL_AUTH_TOKEN ?? ''])) as EvalManifest
}

/** A proven failure survives a later transport error; unresolved errors have no quality denominator. */
export const trialVerdict = (trial: EvalTrial): 'pass' | 'fail' | 'error' => {
  if (trial.attempts.some(({ provenFailure }) => provenFailure)) {
    return 'fail'
  }
  const final = trial.attempts.at(-1)
  if (!final) {
    return 'error'
  }
  if (final.status === 'timeout') {
    return 'fail'
  }
  if (final.status !== 'completed') {
    return 'error'
  }
  return Object.values(final.verdicts).includes('fail') || !final.result.passed ? 'fail' : 'pass'
}

const mean = (values: number[]): number | null =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null

/** Scenario-cluster SEM, not a binomial interval over repeated trials. */
export const scenarioInterval = (values: number[]): ScenarioInterval | null => {
  const average = mean(values)
  if (average === null) {
    return null
  }
  const variance =
    values.length > 1 ? values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1) : 0
  const margin = 1.96 * Math.sqrt(variance / values.length)
  return {
    lower: average - margin,
    upper: average + margin,
    margin,
    scenarios: values.length,
    flagged: values.length < 5 || variance === 0,
    label: `over ${values.length} scenarios; paraphrase families are correlated`,
  }
}

/** Probability that three valid trials drawn without replacement all pass. */
export const passThree = (c: number, valid: number): number | null =>
  valid < 3 ? null : c < 3 ? 0 : (c * (c - 1) * (c - 2)) / (valid * (valid - 1) * (valid - 2))

const summarizeScenario = (scenario: EvalScenario, planned: number, trials: EvalTrial[]): EvalScenarioMetrics => {
  const c = trials.filter((trial) => trialVerdict(trial) === 'pass').length
  const f = trials.filter((trial) => trialVerdict(trial) === 'fail').length
  const e = planned - c - f
  return {
    prompt: scenario.followUps?.at(-1) ?? scenario.prompt,
    category: scenario.category ?? 'core',
    c,
    f,
    e,
    n: planned,
    behaviour: c > 0 ? (f > 0 ? 'flaky' : 'pass') : f > 0 ? 'fail' : 'none',
    completeness: e === 0 ? 'complete' : e === planned ? 'error' : 'partial',
    rate: c + f > 0 ? c / (c + f) : null,
    failures: [...new Set(trials.flatMap(({ attempts }) => attempts.flatMap(({ result }) => result.failures)))],
    reviewBy: scenario.reviewBy ?? null,
  }
}

const categoryMetrics = (
  scenarios: EvalScenarioMetrics[],
  category: NecessityCategory,
  consistency: boolean,
): NecessityCategoryMetrics => {
  const required = scenarios.filter((scenario) => scenario.category === category)
  const values = required.flatMap(({ rate }) => (rate === null ? [] : [rate]))
  const valid = required.reduce((sum, { c, f }) => sum + c + f, 0)
  const planned = required.reduce((sum, { n }) => sum + n, 0)
  const rate = mean(values)
  const threshold = categoryGateThresholds[category]
  const eligible = required.map(({ c, f }) => passThree(c, c + f)).filter((value) => value !== null)
  return {
    state: !required.length
      ? 'not_applicable'
      : values.length < required.length || valid / planned < 0.8
        ? 'unmeasured'
        : rate !== null && rate >= threshold
          ? 'pass'
          : 'fail',
    rate,
    valid,
    planned,
    scenarios: required.length,
    measuredScenarios: values.length,
    interval: scenarioInterval(values),
    threshold,
    ...(consistency ? { pass3: { rate: mean(eligible), eligible: eligible.length, required: required.length } } : {}),
    endToEnd: mean(required.map(({ c, n }) => c / n)),
  }
}

const rateMetric = (count: number, total: number, planned: number): NecessityRateMetric => ({
  state: planned === 0 ? 'not_applicable' : total === 0 ? 'unmeasured' : count / total <= 0.05 ? 'pass' : 'fail',
  count,
  total,
  planned,
  rate: total === 0 ? null : count / total,
  threshold: 0.05,
})

const firstGenerationErrored = (trial: EvalTrial): boolean => trial.attempts[0]?.status === 'infra_error'
const firstJudgeErrored = (trial: EvalTrial): boolean =>
  trial.attempts.find(({ result }) => result.judgeAttempts?.length)?.result.judgeAttempts?.[0]?.status ===
    'judge_error' || trial.attempts[0]?.status === 'judge_error'

const aggregateGroup = (
  cell: EvalManifest['cells'][number],
  manifest: EvalManifest,
  trials: EvalTrial[],
): EvalMetricsGroup => {
  const required = manifest.scenarios.filter(
    ({ scenario }) => `${scenario.modelName}/${scenario.engineName}` === cell.key,
  )
  const scenarios = Object.fromEntries(
    required.map(({ scenario, planned }) => [
      scenario.id,
      summarizeScenario(
        scenario,
        planned,
        trials.filter((trial) => trial.scenario.id === scenario.id),
      ),
    ]),
  )
  const summaries = Object.values(scenarios)
  const categories = Object.fromEntries(
    (Object.keys(categoryGateThresholds) as NecessityCategory[]).map((category) => [
      category,
      categoryMetrics(summaries, category, manifest.samples >= 3 && !manifest.smoke),
    ]),
  ) as EvalMetricsGroup['categories']
  const necessity = required.filter(
    ({ scenario }) => scenario.category && scenario.category !== 'language' && scenario.category !== 'search_wont_help',
  )
  const noSearch = necessity.filter(({ scenario }) => scenario.criteria.maxToolCalls === 0)
  const search = necessity.filter(({ scenario }) => (scenario.criteria.minToolCalls ?? 0) > 0)
  const observedAttempt = (trial: EvalTrial) =>
    trial.attempts.find(({ provenFailure }) => provenFailure) ?? trial.attempts.at(-1)
  const validFor = (selected: typeof required) =>
    trials.filter(
      (trial) =>
        selected.some(({ scenario }) => scenario.id === trial.scenario.id) &&
        trialVerdict(trial) !== 'error' &&
        observedAttempt(trial)?.scoredTurnReached === true,
    )
  const noSearchTrials = validFor(noSearch)
  const searchTrials = validFor(search)
  const calls = (trial: EvalTrial) => observedAttempt(trial)!.result.toolCallCount
  const plannedFor = (selected: typeof required) => selected.reduce((sum, { planned }) => sum + planned, 0)
  const planned = plannedFor(required)
  const errors = summaries.reduce((sum, { e }) => sum + e, 0)
  const firstAttemptGenerationErrors = trials.filter(firstGenerationErrored).length
  const firstAttemptJudgeErrors = trials.filter(firstJudgeErrored).length
  const firstAttemptErrors = trials.filter((trial) => firstGenerationErrored(trial) || firstJudgeErrored(trial)).length
  return {
    model: cell.model,
    engine: cell.engine,
    scenarios,
    categories,
    headline: {
      unnecessarySearchRate: rateMetric(
        noSearchTrials.filter((trial) => calls(trial) > 0).length,
        noSearchTrials.length,
        plannedFor(noSearch),
      ),
      missedSearchRate: rateMetric(
        searchTrials.filter((trial) => calls(trial) === 0).length,
        searchTrials.length,
        plannedFor(search),
      ),
      meanWebCallsNoSearchExpected: mean(noSearchTrials.map(calls)),
    },
    reliability: {
      errors,
      planned,
      rate: planned ? errors / planned : 1,
      firstAttemptGenerationErrors,
      firstAttemptJudgeErrors,
      firstAttemptErrors,
      firstAttemptErrorRate: planned ? firstAttemptErrors / planned : 0,
      toolInfraErrorRate: planned
        ? trials.filter(({ attempts }) => attempts.some(({ toolEvents }) => toolEvents.toolInfraError > 0)).length /
          planned
        : 0,
      toolMisuseRate: planned
        ? trials.filter(({ attempts }) => attempts.some(({ toolEvents }) => toolEvents.toolMisuse > 0)).length / planned
        : 0,
    },
    scoredTurnNotReached: trials.filter((trial) => observedAttempt(trial)?.scoredTurnReached === false).length,
    // Core has n=1 and no category threshold: ANY failure or error is non-passing.
    corePassed: summaries.filter(({ category }) => category === 'core').every(({ f, e }) => f === 0 && e === 0),
  }
}

/** Aggregate against planned trials, including missing completions; never infer coverage from returned results. */
export const aggregateEvalMetrics = (
  manifest: EvalManifest,
  trials: EvalTrial[],
  generatedAt = new Date().toISOString(),
  harnessCrashed = false,
): EvalMetrics => {
  const ids = new Set<string>()
  for (const trial of trials) {
    const planned = manifest.scenarios.find(({ scenario }) => scenario.id === trial.scenario.id)
    if (
      !planned ||
      !Number.isInteger(trial.index) ||
      trial.index < 0 ||
      trial.index >= planned.planned ||
      trial.id !== `${trial.scenario.id}/${trial.index}` ||
      ids.has(trial.id)
    ) {
      throw new Error(`Unexpected or duplicate trial: ${trial.id}`)
    }
    ids.add(trial.id)
  }
  const groups = Object.fromEntries(
    manifest.cells.map((cell) => [
      cell.key,
      aggregateGroup(
        cell,
        manifest,
        trials.filter(({ scenario }) => `${scenario.modelName}/${scenario.engineName}` === cell.key),
      ),
    ]),
  )
  const reliability = Object.values(groups).map(({ reliability }) => reliability)
  const planned = reliability.reduce((sum, group) => sum + group.planned, 0)
  return {
    schemaVersion: 4,
    manifest,
    trials,
    generatedAt,
    harnessCrashed,
    groups,
    pooledErrorRate: planned ? reliability.reduce((sum, group) => sum + group.errors, 0) / planned : 1,
  }
}

/** One acceptance policy for every consumer, with reliability/crash (2) before quality/coverage (1). */
export const acceptEval = (metrics: EvalMetrics): EvalAcceptance => {
  const cells = Object.fromEntries(
    metrics.manifest.cells.map((cell) => {
      const group = metrics.groups[cell.key]
      if (!group) {
        return [cell.key, { exitCode: 1 as const, reasons: ['Required cell absent'] }]
      }
      const required = metrics.manifest.scenarios.filter(
        ({ scenario }) => `${scenario.modelName}/${scenario.engineName}` === cell.key,
      )
      const requiredCategories = [
        ...new Set(required.flatMap(({ scenario }) => (scenario.category ? [scenario.category] : []))),
      ]
      const reasons = [
        ...(!required.length ? ['Required cell has no scenarios'] : []),
        ...required
          .filter(({ scenario }) => !group.scenarios[scenario.id])
          .map(({ scenario }) => `Required scenario absent: ${scenario.id}`),
        ...requiredCategories
          .filter((category) => group.categories[category]?.state !== 'pass')
          .map((category) => `${category}: ${group.categories[category]?.state ?? 'absent'}`),
        ...(['unnecessarySearchRate', 'missedSearchRate'] as const)
          .filter((key) => ['fail', 'unmeasured'].includes(group.headline[key].state))
          .map((key) => `${key}: ${group.headline[key].state}`),
        ...(!group.corePassed ? ['Core trial non-passing'] : []),
        ...(group.reliability.rate > 0.1 ? ['Post-retry error rate exceeds 10%'] : []),
      ]
      return [
        cell.key,
        {
          exitCode: group.reliability.rate > 0.1 ? (2 as const) : reasons.length ? (1 as const) : (0 as const),
          reasons,
        },
      ]
    }),
  )
  const reasons = [
    ...(metrics.harnessCrashed ? ['Harness crashed'] : []),
    ...(!metrics.manifest.cells.length ? ['Required cells absent'] : []),
    ...Object.entries(cells).flatMap(([key, cell]) => cell.reasons.map((reason) => `${key}: ${reason}`)),
  ]
  const exitCode =
    metrics.harnessCrashed || Object.values(cells).some((cell) => cell.exitCode === 2) ? 2 : reasons.length ? 1 : 0
  return { exitCode, partial: metrics.manifest.partial, reasons, cells }
}

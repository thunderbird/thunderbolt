/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'
import type { WidgetName } from '@/widgets'
import type { JudgeVerdict } from './judge'
import type { AppLocale } from '@shared/i18n/locales'

export type { WidgetName }

export type EvalEngine = 'pi' | 'legacy'

export type NecessityCategory =
  | 'never_search'
  | 'answer_then_offer'
  | 'single_search'
  | 'research'
  | 'unknown_entity'
  | 'false_premise'
  | 'adversarial_no_search'
  | 'multi_turn_reuse'
  | 'search_wont_help'
  /**
   * Reply-language adherence. Not a search-necessity category — it shares the
   * scored-category machinery (samples, gate, scenario interval) because the
   * behaviour is equally stochastic, but it is excluded from the search headline
   * rates in `stats.ts`.
   */
  | 'language'

/** A single evaluation scenario: one prompt tested against one model in one mode */
export type EvalScenario = {
  id: string
  modelName: string
  engineName: EvalEngine
  modeName: 'chat' | 'search' | 'research'
  prompt: string
  /**
   * Optional follow-up user turns. When present the scenario runs as a
   * multi-turn conversation: each follow-up is sent after the prior turn's
   * assistant message (including its tool results) is fed back into history,
   * exactly as production does. Scoring applies to the FINAL turn — used to
   * measure whether the model reuses earlier results instead of re-searching.
   */
  followUps?: string[]
  criteria: EvalCriteria
  category?: NecessityCategory
  reviewBy?: string
  isNegativeControl?: boolean
}

/** What to check in the response */
export type EvalCriteria = {
  mustProduceOutput: boolean
  minCitations?: number
  mustUseLinkPreviews?: boolean
  mustUseWidget?: WidgetName
  mustNotUseWidgets?: boolean
  noHomepageLinks?: boolean
  noReviewSites?: boolean
  maxSteps?: number
  /** Minimum built-in web calls required in the final turn. */
  minToolCalls?: number
  /** Maximum built-in web calls allowed in the final turn. */
  maxToolCalls?: number
  noDuplicateToolCalls?: boolean
  expectCorrectAnswer?: boolean
  expectSearchOffer?: boolean
  expectPremiseRebuttal?: boolean
  expectVerificationDisclaimer?: boolean
  /**
   * The language the reply must be written in. Judged semantically, so the
   * assertion is about the assistant's own prose — quoted English sources, code,
   * and proper nouns inside an otherwise Portuguese answer still pass.
   */
  expectReplyLanguage?: AppLocale
}

/** Parsed stream output from a single AI response */
export type ParsedStream = {
  text: string
  toolCalls: ToolCallInfo[]
  /**
   * Assistant message parts reconstructed from the stream (completed tool calls
   * with their outputs, then the final text). Fed back as history for the next
   * turn of a multi-turn scenario.
   */
  assistantParts: ThunderboltUIMessage['parts']
  stepCount: number
  retryCount: number
  finishReason: string
  error?: string
  errorStack?: string
  unclassified?: boolean
  events?: Record<string, unknown>[]
}

export type ToolCallInfo = {
  toolName: string
  toolCallId: string
  /** Finalized tool input — used to detect duplicate (toolName, input) calls. */
  input?: unknown
}

/** Scored result for a single scenario */
export type EvalResult = {
  scenario: EvalScenario
  passed: boolean
  failures: string[]
  responseText: string
  responseLength: number
  citations: string[]
  widgets: string[]
  linkPreviewUrls: string[]
  homepageUrls: string[]
  reviewSiteUrls: string[]
  /** Built-in web calls (`search` and `fetch_content`) in the scored turn. */
  toolCallCount: number
  /** Web calls whose (toolName, input) repeated an earlier call in the scored turn. */
  duplicateToolCallCount: number
  retryCount: number
  durationMs: number
  error?: string
  judgeVerdict?: JudgeVerdict
  judgeAttempts?: JudgeAttempt[]
}

export type Verdict = 'pass' | 'fail' | 'unknown'
export type ExecutionStatus = 'completed' | 'timeout' | 'infra_error' | 'judge_error'
export type CategoryState = 'not_applicable' | 'unmeasured' | 'pass' | 'fail'

export type JudgeAttempt = {
  status: 'completed' | 'judge_error'
  durationMs: number
  verdict?: JudgeVerdict
  error?: string
}

export type EvalAttempt = {
  threadId: string
  status: ExecutionStatus
  error?: string
  errorStack?: string
  unclassified?: boolean
  generationDurationMs: number
  judgeDurationMs: number
  streams: ParsedStream[]
  scoredTurnReached: boolean
  result: EvalResult
  verdicts: Record<string, Verdict>
  provenFailure: boolean
  toolEvents: { toolInfraError: number; toolMisuse: number; budgetDenial: number }
  instrumentation: {
    emitted: number
    executed: number
    cacheHits: number
    initialCap: number
    finalCap: number
    promoted: boolean
    researchSkill: { attempted: boolean; loaded: boolean; beforeFirstWebResult: boolean | null }
    preflight: unknown
  }
}

export type EvalTrial = {
  id: string
  scenario: EvalScenario
  index: number
  attempts: EvalAttempt[]
}

export type EvalManifest = {
  cells: { key: string; model: string; engine: EvalEngine; modelId: string }[]
  suites: string[]
  scenarios: { scenario: EvalScenario; planned: number }[]
  settings: Record<string, string>
  samples: number
  timeout: number
  judgeTimeout: number
  judgeModelId: string
  judgePromptVersion: string
  rubricHash: string
  providerKind: string
  auth: 'present' | 'absent'
  partial: boolean
  smoke: boolean
  treatment: {
    generationRevision: { commit: string; overlayCommit: string | null }
    systemPromptVersion: string
    WEB_BUDGET_PROMOTION: string
  }
  preflight: unknown
}

export type ScenarioInterval = {
  lower: number
  upper: number
  margin: number
  scenarios: number
  flagged: boolean
  label: string
}

export type NecessityCategoryMetrics = {
  state: CategoryState
  rate: number | null
  valid: number
  planned: number
  scenarios: number
  measuredScenarios: number
  interval: ScenarioInterval | null
  threshold: number
  pass3?: { rate: number | null; eligible: number; required: number }
  endToEnd: number | null
}

export type NecessityRateMetric = {
  state: CategoryState
  count: number
  total: number
  planned: number
  rate: number | null
  threshold: number
}

export type EvalScenarioMetrics = {
  prompt: string
  category: NecessityCategory | 'core'
  c: number
  f: number
  e: number
  n: number
  behaviour: 'pass' | 'flaky' | 'fail' | 'none'
  completeness: 'complete' | 'partial' | 'error'
  rate: number | null
  failures: string[]
  reviewBy: string | null
}

export type EvalScenarioComparison = {
  baselineRate: number | null
  currentRate: number | null
  delta: number | null
  direction: 'improved' | 'regressed' | 'unchanged' | 'not comparable'
}

export type EvalMetricsGroup = {
  model: string
  engine: EvalEngine
  scenarios: Record<string, EvalScenarioMetrics>
  categories: Record<NecessityCategory, NecessityCategoryMetrics>
  headline: {
    unnecessarySearchRate: NecessityRateMetric
    missedSearchRate: NecessityRateMetric
    meanWebCallsNoSearchExpected: number | null
  }
  reliability: {
    errors: number
    planned: number
    rate: number
    firstAttemptGenerationErrors: number
    firstAttemptJudgeErrors: number
    firstAttemptErrors: number
    firstAttemptErrorRate: number
    toolInfraErrorRate: number
    toolMisuseRate: number
  }
  scoredTurnNotReached: number
  corePassed: boolean
}

export type EvalMetrics = {
  schemaVersion: 4
  generatedAt: string
  manifest: EvalManifest
  trials: EvalTrial[]
  harnessCrashed: boolean
  groups: Record<string, EvalMetricsGroup>
  pooledErrorRate: number
}

export type EvalAcceptance = {
  exitCode: 0 | 1 | 2
  partial: boolean
  reasons: string[]
  cells: Record<string, { exitCode: 0 | 1 | 2; reasons: string[] }>
}

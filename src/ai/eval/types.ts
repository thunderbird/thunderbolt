/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'
import type { WidgetName } from '@/widgets'
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
   * scored-category machinery (samples, gate, Wilson interval) because the
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
  sampleCount?: number
  passedSampleCount?: number
  errorSampleCount?: number
}

/** Summary stats for report generation */
export type EvalSummary = {
  total: number
  passed: number
  failed: number
  passRate: number
  byModel: Record<string, { total: number; passed: number; passRate: number }>
  byEngine: Record<string, { total: number; passed: number; passRate: number }>
  byMode: Record<string, { total: number; passed: number; passRate: number }>
}

export type WilsonInterval = {
  lower: number
  upper: number
}

export type NecessityCategoryMetrics = {
  passed: number
  total: number
  rate: number
  wilson: WilsonInterval
  threshold: number
  gatePassed: boolean
}

export type NecessityRateMetric = {
  count: number
  total: number
  rate: number
  threshold: number
  gatePassed: boolean
}

export type EvalScenarioMetrics = {
  prompt: string
  category: NecessityCategory | 'core'
  passed: boolean
  webToolCalls: number
  duplicateWebToolCalls: number
  sampleCount: number
  passedSampleCount: number
  errorSampleCount: number
  isNegativeControl: boolean
  reviewBy: string | null
  failures: string[]
}

export type EvalScenarioComparison = {
  baselinePassed: boolean | null
  currentPassed: boolean
  direction: 'improved' | 'regressed' | 'unchanged' | 'no-baseline'
}

export type EvalMetricsGroup = {
  model: string
  engine: EvalEngine
  scenarios: Record<string, EvalScenarioMetrics>
  categories: Partial<Record<NecessityCategory, NecessityCategoryMetrics>>
  headline: {
    unnecessarySearchRate: NecessityRateMetric
    missedSearchRate: NecessityRateMetric
    meanWebCallsNoSearchExpected: number
  }
}

export type EvalMetrics = {
  schemaVersion: 3
  generatedAt: string
  groups: Record<string, EvalMetricsGroup>
}

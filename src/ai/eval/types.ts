/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'

/** A single evaluation scenario: one prompt tested against one model in one mode */
export type EvalScenario = {
  id: string
  modelName: string
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
}

/** What to check in the response */
export type EvalCriteria = {
  mustProduceOutput: boolean
  minCitations?: number
  mustUseLinkPreviews?: boolean
  noHomepageLinks?: boolean
  noReviewSites?: boolean
  maxSteps?: number
  /** Max tool calls allowed in the (final) turn — guards cross-turn reuse. */
  maxToolCalls?: number
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
  toolCallCount: number
  /** Tool calls whose (toolName, input) repeated an earlier call in the run. */
  duplicateToolCallCount: number
  retryCount: number
  durationMs: number
  error?: string
}

/** Summary stats for report generation */
export type EvalSummary = {
  total: number
  passed: number
  failed: number
  passRate: number
  byModel: Record<string, { total: number; passed: number; passRate: number }>
  byMode: Record<string, { total: number; passed: number; passRate: number }>
}

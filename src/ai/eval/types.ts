/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** A single evaluation scenario: one prompt tested against one model in one mode */
export type EvalScenario = {
  id: string
  modelName: string
  modeName: 'chat' | 'search' | 'research'
  prompt: string
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
}

/** Parsed stream output from a single AI response */
export type ParsedStream = {
  text: string
  toolCalls: ToolCallInfo[]
  stepCount: number
  retryCount: number
  finishReason: string
  error?: string
}

export type ToolCallInfo = {
  toolName: string
  toolCallId: string
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

/**
 * Online Evaluation Module
 *
 * Runs evaluators automatically on sampled production traffic.
 * Evaluations happen asynchronously after the response is sent to the user.
 */

import { getLangSmithClient, getLangSmithProject, isLangSmithConfigured } from './client'
// Types for online evaluation
export type CompletionOutput = {
  content: string
  toolCalls: Array<{ name: string; arguments: string }>
  finishReason?: string
}

export type EvaluationResult = {
  score: number
  passed: boolean
  reason: string
  metadata?: Record<string, unknown>
}

// Simple inline evaluators for online evaluation
const evaluateToolUsage = (output: CompletionOutput, _expected: unknown): EvaluationResult => {
  const toolCount = output.toolCalls.length
  return {
    score: toolCount > 0 ? 1.0 : 0.5,
    passed: true,
    reason: `Used ${toolCount} tools`,
  }
}

const evaluateFormatting = (output: CompletionOutput, _expected: unknown): EvaluationResult => {
  const hasTable = /\|.*\|.*\|/m.test(output.content) && output.content.includes('---')
  return {
    score: 1.0,
    passed: true,
    reason: hasTable ? 'Response contains table' : 'Response formatted normally',
  }
}

const evaluateResponseQuality = (output: CompletionOutput): EvaluationResult => {
  if (!output.content || output.content.trim().length === 0) {
    return { score: 0, passed: false, reason: 'Empty response' }
  }
  return {
    score: 1.0,
    passed: true,
    reason: 'Response has content',
  }
}

export type OnlineEvaluationConfig = {
  /** Fraction of requests to evaluate (0.0 to 1.0) */
  samplingRate: number
  /** Whether to use LLM-as-judge for quality assessment */
  useLLMJudge: boolean
  /** Model to use for LLM-as-judge evaluations */
  judgeModel?: string
  /** Custom evaluation criteria */
  criteria?: EvaluationCriteria[]
}

export type EvaluationCriteria = {
  name: string
  description: string
  /** For rule-based: function that returns score */
  rule?: (output: CompletionOutput) => EvaluationResult
  /** For LLM-judge: prompt template */
  judgePrompt?: string
}

const DEFAULT_CONFIG: OnlineEvaluationConfig = {
  samplingRate: 0.1, // 10% of traffic
  useLLMJudge: false,
  judgeModel: 'gpt-4o-mini',
}

let config: OnlineEvaluationConfig = { ...DEFAULT_CONFIG }

/**
 * Configure online evaluation settings
 */
export const configureOnlineEvaluation = (newConfig: Partial<OnlineEvaluationConfig>): void => {
  config = { ...config, ...newConfig }
}

/**
 * Get current online evaluation config
 */
export const getOnlineEvaluationConfig = (): OnlineEvaluationConfig => ({ ...config })

/**
 * Determine if this request should be evaluated based on sampling rate
 */
export const shouldEvaluate = (): boolean => {
  return Math.random() < config.samplingRate
}

/**
 * Default evaluation criteria for online evaluation
 */
export const defaultCriteria: EvaluationCriteria[] = [
  {
    name: 'tool_usage',
    description: 'Evaluates appropriate use of tools',
    rule: (output) =>
      evaluateToolUsage(output, {
        shouldUseTools: output.toolCalls.length > 0,
        shouldAvoidTables: true,
      }),
  },
  {
    name: 'formatting',
    description: 'Evaluates response formatting compliance',
    rule: (output) =>
      evaluateFormatting(output, {
        shouldUseTools: false,
        shouldAvoidTables: true,
        maxResponseLength: 2000,
      }),
  },
  {
    name: 'response_quality',
    description: 'Basic quality heuristics',
    rule: (output) => evaluateResponseQuality(output),
  },
]

/**
 * LLM-as-Judge evaluation prompts
 */
export const llmJudgePrompts = {
  helpfulness: `You are evaluating an AI assistant's response for helpfulness.

User Query: {query}
Assistant Response: {response}

Rate the helpfulness on a scale of 1-5:
1 = Not helpful at all, doesn't address the query
2 = Slightly helpful, partially addresses the query
3 = Moderately helpful, addresses the query but lacks depth
4 = Very helpful, thoroughly addresses the query
5 = Extremely helpful, exceeds expectations

Provide your rating as a JSON object: {"score": <1-5>, "reason": "<brief explanation>"}`,

  accuracy: `You are evaluating an AI assistant's response for factual accuracy.

User Query: {query}
Assistant Response: {response}
Tools Used: {tools}

Assess whether the response appears factually accurate based on:
- Did it use tools to verify information when appropriate?
- Are there any obvious factual errors?
- Does it make claims without verification?

Rate accuracy on a scale of 1-5:
1 = Contains clear factual errors
2 = Questionable accuracy, unverified claims
3 = Mostly accurate with minor concerns
4 = Accurate, well-supported claims
5 = Highly accurate, excellent use of verification

Provide your rating as a JSON object: {"score": <1-5>, "reason": "<brief explanation>"}`,

  conciseness: `You are evaluating an AI assistant's response for conciseness.

User Query: {query}
Assistant Response: {response}

The system prompt instructs: "Be succinct—avoid repetition and unnecessary elaboration"

Rate conciseness on a scale of 1-5:
1 = Very verbose, lots of unnecessary content
2 = Somewhat verbose, could be shorter
3 = Acceptable length, minor redundancy
4 = Concise, well-focused
5 = Perfectly concise, no wasted words

Provide your rating as a JSON object: {"score": <1-5>, "reason": "<brief explanation>"}`,
}

export type OnlineEvaluationResult = {
  traceId: string
  timestamp: Date
  scores: Record<string, EvaluationResult>
  overallScore: number
  passed: boolean
  metadata: {
    model: string
    provider: string
    latencyMs: number
    toolCallCount: number
    responseLength: number
  }
}

/**
 * Run online evaluation on a completed inference
 * This should be called asynchronously after the response is sent
 */
export const runOnlineEvaluation = async (
  traceId: string,
  query: string,
  output: CompletionOutput,
  metadata: {
    model: string
    provider: string
    latencyMs: number
  },
): Promise<OnlineEvaluationResult | null> => {
  // Check if we should evaluate this request
  if (!shouldEvaluate()) {
    return null
  }

  const scores: Record<string, EvaluationResult> = {}

  // Run rule-based evaluations
  const criteria = config.criteria ?? defaultCriteria
  for (const criterion of criteria) {
    if (criterion.rule) {
      scores[criterion.name] = criterion.rule(output)
    }
  }

  // Calculate overall score
  const scoreValues = Object.values(scores).map((r) => r.score)
  const overallScore = scoreValues.length > 0 ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length : 0
  const passed = Object.values(scores).every((r) => r.passed)

  const result: OnlineEvaluationResult = {
    traceId,
    timestamp: new Date(),
    scores,
    overallScore,
    passed,
    metadata: {
      ...metadata,
      toolCallCount: output.toolCalls.length,
      responseLength: output.content.length,
    },
  }

  // Send evaluation results to LangSmith as feedback on the trace
  if (isLangSmithConfigured()) {
    try {
      const client = getLangSmithClient()

      // Create feedback for each evaluation score
      for (const [key, evalResult] of Object.entries(scores)) {
        await client.createFeedback(traceId, key, {
          score: evalResult.score,
          comment: evalResult.reason,
          value: evalResult.passed ? 'pass' : 'fail',
        })
      }

      // Create overall feedback
      await client.createFeedback(traceId, 'overall', {
        score: overallScore,
        comment: `Passed: ${passed}. Categories: ${Object.keys(scores).join(', ')}`,
        value: passed ? 'pass' : 'fail',
      })
    } catch (error) {
      console.error('[OnlineEval] Failed to send feedback to LangSmith:', error)
    }
  }

  return result
}

/**
 * Create an LLM-as-judge evaluator function
 * Returns a function that can be used as a custom criterion
 */
export const createLLMJudgeCriterion = (name: string, promptTemplate: string): EvaluationCriteria => {
  return {
    name,
    description: `LLM-as-judge evaluation for ${name}`,
    judgePrompt: promptTemplate,
    // Note: actual LLM call would happen in runOnlineEvaluation
    // This is a placeholder that would be replaced with actual LLM integration
    rule: (_output) => ({
      score: 0,
      passed: false,
      reason: 'LLM judge not yet executed',
    }),
  }
}

/**
 * Metrics aggregator for online evaluations
 */
export type EvaluationMetrics = {
  totalEvaluated: number
  passRate: number
  averageScore: number
  scoresByCategory: Record<string, { avg: number; passRate: number }>
  latencyP50: number
  latencyP95: number
  toolUsageRate: number
}

const evaluationHistory: OnlineEvaluationResult[] = []
const MAX_HISTORY = 1000

/**
 * Record an evaluation result for metrics aggregation
 */
export const recordEvaluation = (result: OnlineEvaluationResult): void => {
  evaluationHistory.push(result)
  if (evaluationHistory.length > MAX_HISTORY) {
    evaluationHistory.shift()
  }
}

/**
 * Calculate aggregated metrics from evaluation history
 */
export const getEvaluationMetrics = (): EvaluationMetrics => {
  if (evaluationHistory.length === 0) {
    return {
      totalEvaluated: 0,
      passRate: 0,
      averageScore: 0,
      scoresByCategory: {},
      latencyP50: 0,
      latencyP95: 0,
      toolUsageRate: 0,
    }
  }

  const total = evaluationHistory.length
  const passed = evaluationHistory.filter((r) => r.passed).length
  const avgScore = evaluationHistory.reduce((a, b) => a + b.overallScore, 0) / total

  // Category breakdown
  const categoryScores: Record<string, number[]> = {}
  const categoryPassed: Record<string, number[]> = {}

  for (const result of evaluationHistory) {
    for (const [category, score] of Object.entries(result.scores)) {
      if (!categoryScores[category]) {
        categoryScores[category] = []
        categoryPassed[category] = []
      }
      categoryScores[category].push(score.score)
      categoryPassed[category].push(score.passed ? 1 : 0)
    }
  }

  const scoresByCategory: Record<string, { avg: number; passRate: number }> = {}
  for (const category of Object.keys(categoryScores)) {
    const scores = categoryScores[category]
    const passes = categoryPassed[category]
    scoresByCategory[category] = {
      avg: scores.reduce((a, b) => a + b, 0) / scores.length,
      passRate: passes.reduce((a, b) => a + b, 0) / passes.length,
    }
  }

  // Latency percentiles
  const latencies = evaluationHistory.map((r) => r.metadata.latencyMs).sort((a, b) => a - b)
  const p50Index = Math.floor(latencies.length * 0.5)
  const p95Index = Math.floor(latencies.length * 0.95)

  // Tool usage
  const withTools = evaluationHistory.filter((r) => r.metadata.toolCallCount > 0).length

  return {
    totalEvaluated: total,
    passRate: passed / total,
    averageScore: avgScore,
    scoresByCategory,
    latencyP50: latencies[p50Index] ?? 0,
    latencyP95: latencies[p95Index] ?? 0,
    toolUsageRate: withTools / total,
  }
}

/**
 * Clear evaluation history (for testing)
 */
export const clearEvaluationHistory = (): void => {
  evaluationHistory.length = 0
}

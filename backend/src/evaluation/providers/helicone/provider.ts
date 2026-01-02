/**
 * Helicone Provider
 *
 * Integrates with Helicone for:
 * - Fetching production traces via REST API
 * - Attaching evaluation scores to existing requests
 */

import type {
  Provider,
  Reporter,
  TraceFetchResult,
  TraceSampleOptions,
  Trace,
  TraceEvaluationConfig,
  TraceEvaluationResult,
} from '../../core'
import type { ProviderOptions } from '../registry'
import { createHeliconeReporter } from './reporter'

/** Helicone API base URL */
const HELICONE_API_URL = 'https://api.helicone.ai'

/** Helicone request item from API response */
type HeliconeRequest = {
  request_id: string
  request_created_at: string
  request_body: {
    model?: string
    messages?: Array<{ role: string; content: string }>
  }
  response_body?: {
    choices?: Array<{
      message?: { content: string; tool_calls?: unknown[] }
    }>
  }
  model: string
  latency: number
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  properties?: Record<string, string>
  scores?: Record<string, number>
}

export class HeliconeProvider implements Provider {
  readonly name = 'helicone'
  readonly supportsTraces = true

  private apiKey: string
  private options: ProviderOptions

  constructor(options: ProviderOptions = {}) {
    this.options = options
    this.apiKey = process.env.HELICONE_API_KEY || ''
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('HELICONE_API_KEY environment variable is required')
    }

    // Verify API key by making a simple request
    const response = await fetch(`${HELICONE_API_URL}/v1/request/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filter: { values: {} }, limit: 1 }),
    })

    if (!response.ok) {
      throw new Error(`Helicone API error: ${response.status} - ${await response.text()}`)
    }
  }

  async dispose(): Promise<void> {
    // No cleanup needed
  }

  createReporter(): Reporter {
    return createHeliconeReporter(this.options)
  }

  async fetchTraces(options: TraceSampleOptions = {}): Promise<TraceFetchResult> {
    const limit = options.limit || 50
    const excludeTags = options.excludeTags ?? ['evaluation']

    // Build filter for Helicone query
    const filter: Record<string, unknown> = {}

    if (options.since) {
      filter.request_created_at = { gte: options.since.toISOString() }
    }

    if (options.until) {
      filter.request_created_at = {
        ...(filter.request_created_at as Record<string, string>),
        lte: options.until.toISOString(),
      }
    }

    if (options.errorsOnly) {
      filter.status = { gte: 400 }
    }

    const response = await fetch(`${HELICONE_API_URL}/v1/request/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: Object.keys(filter).length > 0 ? filter : { values: {} },
        limit,
        offset: 0,
        sort: { created_at: 'desc' },
        isCached: false,
      }),
    })

    if (!response.ok) {
      throw new Error(`Helicone API error: ${response.status} - ${await response.text()}`)
    }

    const data = (await response.json()) as { data: HeliconeRequest[]; error: string | null }

    if (data.error) {
      throw new Error(`Helicone API error: ${data.error}`)
    }

    // Convert to our Trace format and filter out evaluation traces
    const traces: Trace[] = []

    for (const req of data.data || []) {
      // Skip if has excluded tags in properties
      const source = req.properties?.source
      if (source && excludeTags.includes(source)) continue

      const trace = heliconeRequestToTrace(req)
      if (trace) traces.push(trace)
    }

    // Random sampling if requested
    const finalTraces = options.random ? traces.sort(() => Math.random() - 0.5) : traces

    return { traces: finalTraces, total: finalTraces.length }
  }

  async runTraceEvaluation<TOutput, TExpected>(
    config: TraceEvaluationConfig<TOutput, TExpected>,
  ): Promise<TraceEvaluationResult> {
    const { name, traces, evaluators, verbose = false } = config

    console.log('')
    console.log('═'.repeat(60))
    console.log(`🔍 ${name.toUpperCase()}`)
    console.log('═'.repeat(60))
    console.log(`Traces: ${traces.length}`)
    console.log(`Evaluators: ${evaluators.length}`)
    console.log(`Mode: Online evaluation (scores attached to original requests)`)
    console.log('')

    const results: TraceEvaluationResult['results'] = []
    const scoresByEvaluator: Record<string, number[]> = {}

    let completed = 0
    const total = traces.length

    for (const trace of traces) {
      const traceScores: Record<string, number> = {}
      let hasError = false

      // Build output object for evaluators
      const output = {
        answer: trace.output.content,
        content: trace.output.content,
        toolCalls: (trace.output.toolCalls || []).map((tc) => ({
          tool: tc.name,
          arguments: typeof tc.arguments === 'string' ? safeParseJSON(tc.arguments) : tc.arguments,
          result: tc.result || '',
        })),
        turnCount: 1,
        latencyMs: trace.latencyMs,
        status: trace.error ? 'error' : 'completed',
        error: trace.error,
      } as TOutput

      // Build test case for evaluators
      const testCase = {
        id: trace.id,
        name: trace.input.question || 'Trace',
        source: 'trace' as const,
        input: trace.input,
        expected: {} as TExpected,
        metadata: trace.metadata,
      }

      // Run each evaluator
      for (const evaluator of evaluators) {
        try {
          const ctx = { testCase, output, latencyMs: trace.latencyMs }

          if (evaluator.shouldSkip?.(ctx)) {
            if (verbose) console.log(`    ⏭️  ${evaluator.name}: skipped`)
            continue
          }

          const score = await evaluator.evaluate(ctx)
          traceScores[evaluator.name] = score.value

          if (!scoresByEvaluator[evaluator.name]) {
            scoresByEvaluator[evaluator.name] = []
          }
          scoresByEvaluator[evaluator.name].push(score.value)

          if (verbose) {
            const icon = score.value >= 0.7 ? '🟢' : score.value >= 0.4 ? '🟡' : '🔴'
            console.log(`    ${icon} ${evaluator.name}: ${(score.value * 100).toFixed(0)}%`)
          }
        } catch (e) {
          hasError = true
          const error = e instanceof Error ? e.message : 'Unknown error'
          if (verbose) console.log(`    ❌ ${evaluator.name}: ${error}`)
        }
      }

      // Calculate overall score
      const scoreValues = Object.values(traceScores)
      const avgScore = scoreValues.length > 0 ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length : 0
      const passed = avgScore >= 0.5

      // Attach scores to original request in Helicone
      if (scoreValues.length > 0) {
        await this.attachScores(trace.id, {
          ...Object.fromEntries(Object.entries(traceScores).map(([k, v]) => [k, Math.round(v * 100)])),
          overall_score: Math.round(avgScore * 100),
        })
      }

      completed++
      const statusIcon = hasError ? '❌' : passed ? '✅' : '⚠️'
      const traceName = (trace.input.question || trace.id).slice(0, 40)
      console.log(`[${completed}/${total}] ${statusIcon} ${traceName.padEnd(40)} ${(avgScore * 100).toFixed(0)}%`)

      results.push({
        traceId: trace.id,
        scores: traceScores,
        passed,
        error: hasError ? 'Evaluation error' : undefined,
      })
    }

    // Calculate summary
    const passedCount = results.filter((r) => r.passed).length
    const failed = results.filter((r) => !r.passed && !r.error).length
    const errored = results.filter((r) => !!r.error).length
    const allScores = results.flatMap((r) => Object.values(r.scores))
    const avgScore = allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0

    const avgByEvaluator: Record<string, number> = {}
    for (const [evalName, scores] of Object.entries(scoresByEvaluator)) {
      avgByEvaluator[evalName] = scores.reduce((a, b) => a + b, 0) / scores.length
    }

    // Print summary
    console.log('')
    console.log('═'.repeat(60))
    console.log('📊 RESULTS')
    console.log('═'.repeat(60))
    console.log(`Passed: ${passedCount}/${total} (${((passedCount / total) * 100).toFixed(0)}%)`)
    console.log(`Avg Score: ${(avgScore * 100).toFixed(1)}%`)
    if (errored > 0) console.log(`Errors: ${errored}`)

    console.log('')
    console.log('Scores by evaluator:')
    for (const [evalName, avg] of Object.entries(avgByEvaluator)) {
      const icon = avg >= 0.7 ? '🟢' : avg >= 0.4 ? '🟡' : '🔴'
      console.log(`  ${icon} ${evalName}: ${(avg * 100).toFixed(0)}%`)
    }

    console.log('')
    console.log(`📈 View scores in Helicone: https://www.helicone.ai/requests`)
    console.log(`   Scores attached to ${total} original requests`)
    console.log('')

    return {
      total,
      passed: passedCount,
      failed,
      errored,
      avgScore,
      scoresByEvaluator: avgByEvaluator,
      results,
    }
  }

  /** Attach scores to an existing request in Helicone */
  private async attachScores(requestId: string, scores: Record<string, number>): Promise<void> {
    const response = await fetch(`${HELICONE_API_URL}/v1/request/${requestId}/score`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scores }),
    })

    if (!response.ok && this.options.verbose) {
      console.warn(`Failed to attach scores to request ${requestId}: ${response.status}`)
    }
  }
}

/** Convert Helicone request to our Trace format */
const heliconeRequestToTrace = (req: HeliconeRequest): Trace | null => {
  try {
    const messages = req.request_body?.messages || []
    const userMessage = messages.find((m) => m.role === 'user')
    const question = userMessage?.content || ''

    const responseContent = req.response_body?.choices?.[0]?.message?.content || ''

    return {
      id: req.request_id,
      timestamp: new Date(req.request_created_at),
      model: req.model || req.request_body?.model || 'unknown',
      input: {
        messages: messages.map((m) => ({
          role: m.role as 'system' | 'user' | 'assistant' | 'tool',
          content: m.content,
        })),
        question,
      },
      output: {
        content: responseContent,
        toolCalls: [], // Helicone doesn't provide tool calls in the same format
      },
      latencyMs: req.latency || 0,
      tokens: req.total_tokens
        ? {
            input: req.prompt_tokens || 0,
            output: req.completion_tokens || 0,
            total: req.total_tokens,
          }
        : undefined,
      metadata: {
        properties: req.properties,
        scores: req.scores,
      },
    }
  } catch {
    return null
  }
}

/** Safely parse JSON */
const safeParseJSON = (str: string): Record<string, unknown> => {
  try {
    return JSON.parse(str) as Record<string, unknown>
  } catch {
    return {}
  }
}

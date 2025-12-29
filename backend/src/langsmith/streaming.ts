import type { Stream } from 'openai/streaming'
import type { ChatCompletionChunk as OpenAIChatCompletionChunk } from 'openai/resources/chat/completions'
import { endInferenceTrace, extractEvaluationMetadata, type TraceContext } from './tracing'
import { getLangSmithClient, getLangSmithProject, isLangSmithConfigured } from './client'
import { runOnlineEvaluation, recordEvaluation } from './online-evaluation'

type ChatCompletionChunk = OpenAIChatCompletionChunk

type CollectedToolCall = {
  id: string
  name: string
  arguments: string
}

type CollectedOutput = {
  content: string
  toolCalls: CollectedToolCall[]
  finishReason?: string
  tokenUsage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

/**
 * Creates a traced SSE stream from an OpenAI completion stream
 * Collects output data for LangSmith tracing while streaming to client
 */
export const createTracedSSEStream = (
  completion: Stream<ChatCompletionChunk>,
  traceContext: TraceContext | null,
  startTime: number,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  let isCancelled = false

  // Accumulated output for tracing
  const collected: CollectedOutput = {
    content: '',
    toolCalls: [],
    finishReason: undefined,
    tokenUsage: undefined,
  }

  // Track tool calls by index (for streaming tool calls)
  const toolCallsInProgress: Map<number, CollectedToolCall> = new Map()

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of completion) {
          if (isCancelled) {
            break
          }

          // Extract and accumulate content for tracing
          const choice = chunk.choices?.[0]
          if (choice?.delta?.content != null) {
            collected.content += choice.delta.content
          }

          // Accumulate tool calls
          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              let existing = toolCallsInProgress.get(tc.index)
              if (!existing) {
                existing = { id: tc.id ?? '', name: '', arguments: '' }
                toolCallsInProgress.set(tc.index, existing)
              }
              if (tc.id) existing.id = tc.id
              if (tc.function?.name) existing.name = tc.function.name
              if (tc.function?.arguments) existing.arguments += tc.function.arguments
            }
          }

          // Capture finish reason
          if (choice?.finish_reason != null) {
            collected.finishReason = choice.finish_reason
          }

          // Capture usage
          if (chunk.usage) {
            collected.tokenUsage = {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            }
          }

          // Forward chunk to client
          const sseChunk = `data: ${JSON.stringify(chunk)}\n\n`
          try {
            controller.enqueue(encoder.encode(sseChunk))
          } catch {
            break
          }
        }

        // Finalize tool calls
        collected.toolCalls = Array.from(toolCallsInProgress.values())

        // Send [DONE] to client
        if (!isCancelled) {
          try {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          } catch {
            // Ignore
          }
        }

        // End the trace with collected output
        if (traceContext) {
          await endInferenceTrace(traceContext, {
            content: collected.content,
            toolCalls: collected.toolCalls.map((tc) => ({
              name: tc.name,
              arguments: tc.arguments,
            })),
            finishReason: collected.finishReason,
            tokenUsage: collected.tokenUsage,
          })

          // Log evaluation metadata for debugging
          if (isLangSmithConfigured()) {
            const evalMetadata = extractEvaluationMetadata(collected.content, collected.toolCalls, startTime)
            console.info('[LangSmith] Trace completed', {
              toolCallCount: evalMetadata.toolCallCount,
              responseLength: evalMetadata.responseLength,
              hasTable: evalMetadata.hasTable,
              latencyMs: evalMetadata.latencyMs,
            })

            // Run online evaluation asynchronously (fire and forget)
            runOnlineEvaluation(
              traceContext.runId,
              '', // Query would need to be passed through
              {
                content: collected.content,
                toolCalls: collected.toolCalls,
                finishReason: collected.finishReason,
              },
              {
                model: 'unknown', // Would need to be passed through
                provider: 'unknown',
                latencyMs: evalMetadata.latencyMs,
              },
            )
              .then((result) => {
                if (result) {
                  recordEvaluation(result)
                }
              })
              .catch((err) => console.error('[OnlineEval] Error:', err))
          }
        }

        if (controller.desiredSize !== null) {
          controller.close()
        }
      } catch (error) {
        // End trace with error
        if (traceContext) {
          await endInferenceTrace(traceContext, {}, error as Error)
        }

        if (!isCancelled) {
          console.error('Streaming error:', error)
          controller.error(error)
        }
      }
    },
    cancel() {
      isCancelled = true
      completion.controller?.abort()

      // End trace on cancellation
      if (traceContext) {
        endInferenceTrace(traceContext, {
          content: collected.content,
          finishReason: 'cancelled',
        }).catch(console.error)
      }
    },
  })
}

/**
 * Start a LangSmith trace for a chat completion request
 *
 * @param messages - Chat messages
 * @param metadata - Request metadata
 * @param sourceTags - Optional tags to identify the source (default: ['production', 'chat'])
 */
export const startChatTrace = async (
  messages: Array<{ role: string; content: unknown }>,
  metadata: {
    model: string
    provider: string
    hasTools: boolean
    temperature?: number
    userId?: string
    sessionId?: string
  },
  sourceTags?: string[],
): Promise<TraceContext | null> => {
  if (!isLangSmithConfigured()) {
    return null
  }

  // Check sampling rate
  const { getLangSmithSamplingRate } = await import('./client')
  const samplingRate = getLangSmithSamplingRate()
  if (Math.random() >= samplingRate) {
    return null
  }

  const client = getLangSmithClient()
  const project = getLangSmithProject()

  // Generate our own run ID since createRun returns void
  const runId = crypto.randomUUID()

  // Default to production tags if not specified
  const tags = sourceTags ?? ['production', 'chat']

  await client.createRun({
    id: runId,
    name: 'chat_completion',
    run_type: 'llm',
    inputs: {
      messages: messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      model: metadata.model,
      provider: metadata.provider,
      has_tools: metadata.hasTools,
      temperature: metadata.temperature,
    },
    extra: {
      metadata: {
        user_id: metadata.userId,
        session_id: metadata.sessionId,
        model: metadata.model,
        provider: metadata.provider,
        // Source tagging for trace differentiation
        source: tags[0], // Primary source: 'production' or 'evaluation'
        source_tags: tags, // Full tag list for filtering
      },
    },
    project_name: project,
  } as Parameters<typeof client.createRun>[0] & { tags?: string[] })

  return {
    runId,
    shouldTrace: true,
  }
}

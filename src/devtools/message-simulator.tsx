import { createSimulatedFetch, parseSseLog } from '@/ai/requests/util'
import { AssistantMessage } from '@/components/chat/assistant-message'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ReasoningUIPart, TextUIPart, ToolInvocationUIPart, UIMessage } from 'ai'
import { extractReasoningMiddleware, streamText, wrapLanguageModel } from 'ai'
import DEFAULT_SSE_CONTENT from '../ai/requests/tests/apple/stream.sse?raw'

import { Play, RotateCcw, Square } from 'lucide-react'
import { useRef, useState } from 'react'

interface SimulatorContentProps {}

function SimulatorContent({}: SimulatorContentProps) {
  const [sseLog, setSseLog] = useState(DEFAULT_SSE_CONTENT)
  const [isSimulating, setIsSimulating] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [realtimeMessage, setRealtimeMessage] = useState<UIMessage<
    ReasoningUIPart | ToolInvocationUIPart | TextUIPart,
    { finishReason: string; messageId: string }
  > | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const startSimulation = async () => {
    if (!sseLog.trim()) return

    // Reset previous simulation
    setRealtimeMessage(null)
    setIsSimulating(true)
    setIsStreaming(true)

    // Create abort controller for cancellation
    abortControllerRef.current = new AbortController()
    const signal = abortControllerRef.current.signal

    try {
      // Create a mock fetch that returns the SSE log
      const chunks = parseSseLog(sseLog)
      const simulatedFetch = createSimulatedFetch(chunks, {
        initialDelayInMs: 200,
        chunkDelayInMs: 20,
      })

      // Initialize a custom OpenAI-compatible provider pointing to a mock URL
      const provider = createOpenAICompatible({
        name: 'test-provide',
        baseURL: 'http://localhost:8000',
        fetch: simulatedFetch,
      })

      // Get a model instance (model id is irrelevant, only used for labeling)
      const baseModel = provider('test-model')

      // Attach only the reasoning extraction middleware (tagName: think)
      const wrappedModel = wrapLanguageModel({
        model: baseModel,
        middleware: [extractReasoningMiddleware({ tagName: 'think' })],
      })

      // Call the Vercel AI SDK streamText helper which gives us a StreamTextResult-like object
      const result = await streamText({
        model: wrappedModel,
        prompt: 'Simulated prompt', // Minimal prompt just to satisfy the SDK API
        abortSignal: signal,
      })

      // -------------------------------------------------------------------
      // Consume the stream emitted by the SDK **as it happens** and build a
      // UIMessage that can be rendered by our <AssistantMessage/> component.
      // -------------------------------------------------------------------

      const reader = result.fullStream.getReader()

      let messageId: string = 'sim'
      let currentTextPart: { type: 'text'; text: string } | null = null
      let currentReasoningPart: { type: 'reasoning'; text: string } | null = null
      const parts: any[] = []

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const chunk: any = value // Cast to any to simplify TypeScript handling of dynamic chunk types

          switch (chunk.type) {
            case 'text': // Fallback for potential future chunk types
              // Accumulate successive text deltas into a single text part so
              // the UI doesn’t have to handle many tiny items.
              if (!currentTextPart) {
                currentTextPart = { type: 'text', text: '' }
                parts.push(currentTextPart)
              }
              // Both chunk.textDelta (preferred) and chunk.text may appear depending on transformer
              currentTextPart.text += chunk.textDelta ?? chunk.text ?? ''
              break

            case 'reasoning':
              // Accumulate successive reasoning chunks into one part.
              if (!currentReasoningPart) {
                currentReasoningPart = { type: 'reasoning', text: '' }
                parts.push(currentReasoningPart)
              }
              currentReasoningPart.text += chunk.text ?? ''
              break

            case 'finish':
              // Capture the final messageId if present (OpenAI style streams
              // often include it in the last chunk).
              if (chunk.messageId) {
                messageId = chunk.messageId
              }
              break

            default:
              // Ignore other chunk types for this simulator.
              break
          }

          // Push the latest snapshot to the React state so the UI updates in
          // real-time. Spread `parts` to ensure new reference for React.
          setRealtimeMessage({
            id: messageId,
            role: 'assistant',
            parts: [...parts],
            // Metadata omitted in simulator context
          })
        }
      } finally {
        reader.releaseLock()
      }
    } catch (error) {
      console.error('Simulation error:', error)
    } finally {
      setIsSimulating(false)
      setIsStreaming(false)
    }
  }

  const stopSimulation = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    setIsSimulating(false)
    setIsStreaming(false)
  }

  const resetSimulation = () => {
    stopSimulation()
    setRealtimeMessage(null)
    setSseLog(DEFAULT_SSE_CONTENT)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto">
        <div className="flex flex-col gap-6 p-6 w-full">
          <div>
            <h1 className="text-3xl font-bold">Message Simulator</h1>
          </div>

          {/* SSE Log Input Section - Full Width */}
          <Card>
            <CardHeader>
              <CardTitle>SSE Log Input</CardTitle>
              <CardDescription>
                You can paste an SSE log here to recreate the message streaming process.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                placeholder="SSE content will be processed by the actual streamText function..."
                value={sseLog}
                onChange={(e) => setSseLog(e.target.value)}
                className="min-h-[200px] font-mono text-xs"
                disabled={isSimulating}
              />

              <div className="flex gap-2">
                <Button
                  onClick={startSimulation}
                  disabled={isSimulating || !sseLog.trim()}
                  className="flex items-center gap-2"
                >
                  <Play size={16} />
                  {isSimulating ? 'Running...' : 'Run'}
                </Button>

                {isSimulating && (
                  <Button onClick={stopSimulation} variant="destructive" className="flex items-center gap-2">
                    <Square size={16} />
                    Stop
                  </Button>
                )}

                <Button
                  onClick={resetSimulation}
                  variant="outline"
                  className="flex items-center gap-2"
                  disabled={isSimulating}
                >
                  <RotateCcw size={16} />
                  Clear
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Bottom Grid: Chat Output and JSON Debug */}
          {realtimeMessage && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Simulated Chat Output */}
              <Card>
                <CardHeader>
                  <CardTitle>Simulated Chat Output</CardTitle>
                  <CardDescription>This shows the UIMessage as it's being built from the SSE log.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="border rounded-md p-4">
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    <AssistantMessage message={realtimeMessage as any} isStreaming={isStreaming} />
                  </div>
                </CardContent>
              </Card>

              {/* Real-time JSON Debug */}
              <Card>
                <CardHeader>
                  <CardTitle>Parsed Message (Real-time)</CardTitle>
                  <CardDescription>JSON structure updates in real-time as the SSE log is processed.</CardDescription>
                </CardHeader>
                <CardContent>
                  <pre className="p-3 bg-muted rounded text-xs whitespace-pre-wrap word-break-all min-h-[200px] max-h-[400px] overflow-y-auto">
                    {realtimeMessage ? JSON.stringify(realtimeMessage, null, 2) : 'No message data yet...'}
                  </pre>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function MessageSimulatorPage() {
  return <SimulatorContent />
}

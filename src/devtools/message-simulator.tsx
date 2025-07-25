import { streamText } from '@/ai/requests/stream-text'
import { streamingParserMiddleware } from '@/ai/middleware/streaming-parser-debug'
import { reasoningPropertyParserMiddleware } from '@/ai/middleware/reasoning-property-parser'
import { AssistantMessage } from '@/components/chat/assistant-message'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import type { Model } from '@/types'
import { type UIMessage } from 'ai'
import { Play, RotateCcw, Square } from 'lucide-react'
import { useRef, useState } from 'react'

// Default SSE content from apple.sse for testing
const DEFAULT_SSE_CONTENT = `data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"<think>\\n"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"Okay, the user is"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" asking for the weather forecast this"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" week. Let me check what"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" I need"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" to do.\\n\\nFirst, I"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" remember that the user doesn"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"'t provided their location yet."},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" The instructions say I should ask"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" for the location before using any"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" location-based tools. Since"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" the weather"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" forecast depends on the"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" location, I can't"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" proceed without that information."},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" \\n\\nI should"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" respond by asking them where"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" they are located."},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" That way, once they"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" provide the city or"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" area, I can use"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" the appropriate tool to get the"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" forecast. I need"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" to make sure I don't"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" mention any tools by name"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":", just ask for the"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" location. \\n\\nAlso,"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" I need to follow the"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" format: use Markdown,"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" sub"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"headers, bullet points, and"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" emojis if appropriate"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":". Let me structure the response"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" politely and clearly"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":". Make sure to explain why"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" I need the location so they"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" understand it's necessary for the"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" forecast. \\n\\nDouble-check"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"ing the guidelines:"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" don't invent info"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":", be honest if I can"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"'t help without the"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" location."},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" Yep, that's covered"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":". Alright, time to put"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" it all together.\\n"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"</think>\\n\\n🌤️"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" **Weekly Weather Forecast Request**"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"  \\n\\nTo provide you with the"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" most accurate forecast,"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" I need to know your **"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"location** (e.g.,"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" city or region). Weather varies"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" by area, and"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" real-time data requires this"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" detail to"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" proceed."},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"  \\n\\nCould you share where you"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":"'re located? Once I have"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" that, I'll fetch the"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" latest forecast for you!"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{"content":" 🌍✨"},"finish_reason":null}],"usage":null}

data: {"id":"7295f0f2-3fff-41e8-8391-61dc1cf831ad","object":"chat.completion.chunk","created":1753398436,"model":"accounts/fireworks/models/qwen3-235b-a22b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":317,"total_tokens":611,"completion_tokens":294}}

data: [DONE]`

// ------------------------------------------------------------
// Helpers to create a mock fetch that streams the SSE log
// ------------------------------------------------------------

const makeMockFetch = (sseData: string): ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => {
  return async () => {
    const encoder = new TextEncoder()
    const lines = sseData.split('\n').filter((l) => l.trim())
    let idx = 0

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (idx >= lines.length) {
          controller.close()
          return
        }

        // Push next line with newline so the parser sees complete lines
        const chunk = encoder.encode(lines[idx++] + '\n')
        controller.enqueue(chunk)

        // Small delay to simulate real streaming
        await new Promise((r) => setTimeout(r, 50))
      },
    })

    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
}

// Dummy model instance (only fields used by streamText)
const dummyModel: Model = {
  id: 'sim',
  provider: 'custom',
  name: 'sim',
  model: 'simulation-model',
  apiKey: '',
  url: '',
  isSystem: 0,
  enabled: 1,
  toolUsage: 1,
  isConfidential: 0,
}

interface SimulatorContentProps {}

function SimulatorContent({}: SimulatorContentProps) {
  const [sseLog, setSseLog] = useState(DEFAULT_SSE_CONTENT)
  const [isSimulating, setIsSimulating] = useState(false)
  const [simulatedMessage, setSimulatedMessage] = useState<UIMessage | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [realtimeMessage, setRealtimeMessage] = useState<Partial<UIMessage> | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const startSimulation = async () => {
    if (!sseLog.trim()) return

    // Reset previous simulation
    setSimulatedMessage(null)
    setRealtimeMessage(null)
    setIsSimulating(true)
    setIsStreaming(true)

    // Create abort controller for cancellation
    abortControllerRef.current = new AbortController()
    const signal = abortControllerRef.current.signal

    // Prepare mock fetch that replays the SSE log
    const mockFetch = makeMockFetch(sseLog)

    try {
      const { stream } = (await streamText({
        model: dummyModel as any,
        messages: [{ role: 'user', content: 'Simulated prompt' }],
        fetch: mockFetch,
        signal,
        middleware: [streamingParserMiddleware, reasoningPropertyParserMiddleware],
      })) as any

      const reader = stream.getReader()

      const parts: any[] = []

      // Initialize empty realtime message
      setRealtimeMessage({ id: 'sim', role: 'assistant', parts })

      // Consume stream
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        if (value.type === 'text' || value.type === 'reasoning') {
          parts.push(value)
          setRealtimeMessage({ id: 'sim', role: 'assistant', parts: [...parts] })
        }

        if (value.type === 'finish') {
          setSimulatedMessage({
            id: 'sim',
            role: 'assistant',
            parts: [...parts],
            metadata: { finishReason: value.finishReason || 'stop', messageId: 'sim' },
          })
        }
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
    setSimulatedMessage(null)
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
              <CardDescription>Paste your SSE log here. Default content is from apple.sse test file.</CardDescription>
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
                    <AssistantMessage message={realtimeMessage as UIMessage} isStreaming={isStreaming} />
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

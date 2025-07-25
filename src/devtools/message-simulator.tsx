import { AssistantMessage } from '@/components/chat/assistant-message'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Header } from '@/components/ui/header'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { Textarea } from '@/components/ui/textarea'
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

/**
 * Parse a single SSE line like the streamText function does
 */
const parseSSELine = (line: string) => {
  if (line.startsWith('data:')) {
    line = line.slice(5).trim()
  }

  if (!line) return {}
  if (line === '[DONE]') {
    return { isFinished: true, finishReason: 'stop' }
  }

  try {
    const payload = JSON.parse(line)
    const choice = payload?.choices?.[0]
    if (!choice) return {}

    const delta = choice.delta ?? {}
    const result: any = {}

    if (payload.id) {
      result.id = payload.id
    }

    if (delta.content) {
      result.textContent = delta.content
    }

    if (choice.finish_reason) {
      result.isFinished = true
      result.finishReason = choice.finish_reason
    }

    return result
  } catch {
    return {}
  }
}

/**
 * Parse content with <think> tags and return appropriate message parts
 */
const parseContentIntoParts = (allTextContent: string, messageId?: string) => {
  const parts: any[] = []

  // Parse reasoning content from <think> tags
  const thinkMatch = allTextContent.match(/<think>([\s\S]*?)<\/think>/)
  if (thinkMatch) {
    const reasoningContent = thinkMatch[1].trim()
    if (reasoningContent) {
      parts.push({
        type: 'reasoning',
        text: reasoningContent,
      })
    }
  }

  // Extract text content (everything after </think> tag, or all content if no think tags)
  let textContent = allTextContent
  if (thinkMatch) {
    const afterThinkIndex = allTextContent.indexOf('</think>') + '</think>'.length
    textContent = allTextContent.substring(afterThinkIndex).trim()
  }

  if (textContent) {
    parts.push({
      type: 'text',
      text: textContent,
    })
  }

  return {
    parts,
    id: messageId || `fallback_${Date.now()}`,
  }
}

/**
 * Simulate the streamText parsing directly from SSE content
 */
const simulateStreamText = async (sseContent: string, signal?: AbortSignal): Promise<UIMessage> => {
  const lines = sseContent.split('\n').filter((line) => line.trim())
  let allTextContent = ''
  let messageId: string | undefined

  // Process each line with delay to simulate streaming
  for (let i = 0; i < lines.length; i++) {
    if (signal?.aborted) throw new Error('Aborted')

    const line = lines[i]
    const parsed = parseSSELine(line)

    // Capture the message ID from the first line that has one
    if (parsed.id && !messageId) {
      messageId = parsed.id
    }

    // Buffer text content as it comes in
    if (parsed.textContent) {
      allTextContent += parsed.textContent
    }

    // When finished, parse the full content and return
    if (parsed.isFinished) {
      const { parts, id } = parseContentIntoParts(allTextContent, messageId)

      return {
        id,
        role: 'assistant',
        parts,
        metadata: { finishReason: parsed.finishReason || 'stop', messageId: id },
      }
    }

    // Add delay between lines for visual effect
    if (i < lines.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  // Fallback if no finish signal was found
  const { parts, id } = parseContentIntoParts(allTextContent, messageId)
  return {
    id,
    role: 'assistant',
    parts,
    metadata: { finishReason: 'stop', messageId: id },
  }
}

interface SimulatorContentProps {}

function SimulatorContent({}: SimulatorContentProps) {
  const [sseLog, setSseLog] = useState(DEFAULT_SSE_CONTENT)
  const [isSimulating, setIsSimulating] = useState(false)
  const [simulatedMessage, setSimulatedMessage] = useState<UIMessage | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  const startSimulation = async () => {
    if (!sseLog.trim()) return

    // Reset previous simulation
    setSimulatedMessage(null)
    setIsSimulating(true)
    setIsStreaming(true)

    // Create abort controller for cancellation
    abortControllerRef.current = new AbortController()
    const signal = abortControllerRef.current.signal

    try {
      // Use our direct SSE parsing simulation
      const finalMessage = await simulateStreamText(sseLog, signal)

      setSimulatedMessage(finalMessage)
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
    setSseLog(DEFAULT_SSE_CONTENT)
  }

  return (
    <SidebarInset>
      <div className="flex flex-col h-full">
        <Header />
        <div className="flex-1 overflow-auto">
          <div className="flex flex-col gap-6 p-6 w-full">
            <div>
              <h1 className="text-3xl font-bold">Message Simulator</h1>
              <p className="text-gray-600 dark:text-gray-400">
                Simulate streaming chat responses by parsing SSE logs. Uses the same parsing logic as streamText with
                50ms delays.
              </p>
            </div>

            <div className="grid gap-6">
              {/* SSE Log Input Section */}
              <Card>
                <CardHeader>
                  <CardTitle>SSE Log Input</CardTitle>
                  <CardDescription>
                    Paste your SSE log here. Default content is from apple.sse test file.
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
                      {isSimulating ? 'Processing...' : 'Start Simulation'}
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
                      Reset to Default
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Simulated Chat Output Section */}
              {simulatedMessage && (
                <Card>
                  <CardHeader>
                    <CardTitle>Simulated Chat Output</CardTitle>
                    <CardDescription>
                      This shows the final UIMessage after parsing the SSE log using the same logic as streamText.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="border rounded-md p-4 max-w-2xl">
                      <AssistantMessage message={simulatedMessage} isStreaming={isStreaming} />
                    </div>

                    {/* Debug info */}
                    <details className="mt-4">
                      <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                        View parsed message details
                      </summary>
                      <pre className="mt-2 p-3 bg-muted rounded text-xs overflow-auto">
                        {JSON.stringify(simulatedMessage, null, 2)}
                      </pre>
                    </details>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </div>
      </div>
    </SidebarInset>
  )
}

export default function MessageSimulatorPage() {
  return (
    <SidebarProvider>
      <SimulatorContent />
    </SidebarProvider>
  )
}

import { createSimulatedFetch, parseSseLog } from '@/ai/streaming/util'
import { AssistantMessage } from '@/components/chat/assistant-message'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { useLocalStorage } from '@/hooks/use-local-storage'
import { getOrCreateChatStore } from '@/lib/chat-store-registry'
import { cn } from '@/lib/utils'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { useChat } from '@ai-sdk/react'
import { streamText, wrapLanguageModel } from 'ai'
import { Check, ChevronsUpDown, Play, RotateCcw, Square } from 'lucide-react'
import { useCallback, useState } from 'react'
import { v7 as uuidv7 } from 'uuid'

import { createDefaultMiddleware } from '@/ai/middleware/default'
import APPLE_SSE_CONTENT from '../ai/streaming/sse-logs/apple.sse?raw'
import BANANA_SSE_CONTENT from '../ai/streaming/sse-logs/banana.sse?raw'
import COMPUTER_1_SSE_CONTENT from '../ai/streaming/sse-logs/computer-1.sse?raw'
import COMPUTER_2_SSE_CONTENT from '../ai/streaming/sse-logs/computer-2.sse?raw'

// Map of SSE log files to their content
const SSE_LOG_FILES = {
  apple: APPLE_SSE_CONTENT,
  banana: BANANA_SSE_CONTENT,
  'computer-1': COMPUTER_1_SSE_CONTENT,
  'computer-2': COMPUTER_2_SSE_CONTENT,
} as const

// Generate SSE logs array from file names
const SSE_LOGS = Object.entries(SSE_LOG_FILES).map(([fileName, content]) => ({
  value: fileName,
  label: fileName.charAt(0).toUpperCase() + fileName.slice(1),
  content,
}))

type SimulatorContentProps = Record<string, never>

function SimulatorContent({}: SimulatorContentProps) {
  const [selectedSse, setSelectedSse] = useLocalStorage('message-simulator-sse', '')
  const [sseLog, setSseLog] = useState(() => {
    const selectedLog = SSE_LOGS.find((log) => log.value === selectedSse)
    return selectedLog?.content || ''
  })
  const [open, setOpen] = useState(false)

  // Create a custom fetch function that simulates the SSE response
  const customFetch = useCallback(
    Object.assign(
      async (_requestInfo: RequestInfo | URL, init?: RequestInit) => {
        console.log('sseLog', sseLog)
        if (!sseLog.trim()) {
          throw new Error('No SSE log content')
        }

        // Create a mock fetch that returns the SSE log
        const chunks = parseSseLog(sseLog)
        const simulatedFetch = createSimulatedFetch(chunks, {
          initialDelayInMs: 200,
          chunkDelayInMs: 20,
        })

        // Simulate the real AI fetch by creating a streamText result
        const provider = createOpenAICompatible({
          name: 'test-provider',
          baseURL: 'http://localhost:8000',
          fetch: simulatedFetch,
        })

        const baseModel = provider('test-model')
        const wrappedModel = wrapLanguageModel({
          model: baseModel,
          middleware: createDefaultMiddleware(),
        })

        const result = streamText({
          model: wrappedModel,
          prompt: 'Simulated prompt',
          abortSignal: init?.signal || undefined,
        })

        // Return the UI message stream response like the real API does
        return result.toUIMessageStreamResponse({
          sendReasoning: true,
          messageMetadata: () => ({ modelId: 'simulator' }),
        })
      },
      {
        preconnect: () => Promise.resolve(false),
      },
    ),
    [sseLog],
  )

  const chatStoreInstance = getOrCreateChatStore('message-simulator', {
    initialMessages: [],
    fetch: customFetch,
  })

  const chatHelpers = useChat({
    id: 'message-simulator',
    chatStore: chatStoreInstance,
    generateId: uuidv7,
    onError: (error) => {
      console.error('Simulation error:', error)
    },
  })

  const { messages, status, stop, setMessages } = chatHelpers
  const isLoading = status === 'streaming'

  const startSimulation = async () => {
    if (!sseLog.trim()) return

    // Start the chat with a simulated prompt
    await chatHelpers.append({
      role: 'user',
      parts: [{ type: 'text', text: 'Simulated prompt' }],
    })
  }

  const stopSimulation = () => {
    stop()
  }

  const resetSimulation = () => {
    stopSimulation()
    setMessages([])
    setSseLog('')
    setSelectedSse('')
  }

  const handleSseSelection = (value: string) => {
    const selectedLog = SSE_LOGS.find((log) => log.value === value)
    if (selectedLog) {
      setSelectedSse(value)
      setSseLog(selectedLog.content)
      setOpen(false)
    }
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
                You can select a predefined SSE log or paste your own SSE log here to recreate the message streaming
                process.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* SSE Log Selection Combobox */}
              <div className="flex flex-col space-y-2">
                <label className="text-sm font-medium">Select SSE Log:</label>
                <Popover open={open} onOpenChange={setOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={open}
                      className="w-[300px] justify-between"
                      disabled={isLoading}
                    >
                      {selectedSse ? SSE_LOGS.find((log) => log.value === selectedSse)?.label : 'Select SSE log...'}
                      <ChevronsUpDown className="opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[300px] p-0">
                    <Command>
                      <CommandInput placeholder="Search SSE logs..." className="h-9" />
                      <CommandList>
                        <CommandEmpty>No SSE log found.</CommandEmpty>
                        <CommandGroup>
                          {SSE_LOGS.map((log) => (
                            <CommandItem key={log.value} value={log.value} onSelect={handleSseSelection}>
                              {log.label}
                              <Check
                                className={cn('ml-auto', selectedSse === log.value ? 'opacity-100' : 'opacity-0')}
                              />
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              <Textarea
                placeholder="SSE content will be processed by the actual streamText function..."
                value={sseLog}
                onChange={(e) => setSseLog(e.target.value)}
                className="min-h-[200px] font-mono text-xs"
                disabled={isLoading}
              />

              <div className="flex gap-2">
                <Button
                  onClick={startSimulation}
                  disabled={isLoading || !sseLog.trim()}
                  className="flex items-center gap-2"
                >
                  <Play size={16} />
                  {isLoading ? 'Running...' : 'Run'}
                </Button>

                {isLoading && (
                  <Button onClick={stopSimulation} variant="destructive" className="flex items-center gap-2">
                    <Square size={16} />
                    Stop
                  </Button>
                )}

                <Button
                  onClick={resetSimulation}
                  variant="outline"
                  className="flex items-center gap-2"
                  disabled={isLoading}
                >
                  <RotateCcw size={16} />
                  Clear
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Bottom Grid: Chat Output and JSON Debug */}
          {messages.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Simulated Chat Output */}
              <Card>
                <CardHeader>
                  <CardTitle>Simulated Chat Output</CardTitle>
                  <CardDescription>This shows the UIMessage as it's being built from the SSE log.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="border rounded-md p-4">
                    {messages
                      .filter((msg) => msg.role === 'assistant')
                      .map((message) => (
                        <AssistantMessage
                          key={message.id}
                          message={message as any}
                          isStreaming={isLoading && messages[messages.length - 1]?.id === message.id}
                        />
                      ))}
                    {messages.length === 0 && <div className="text-muted-foreground">No assistant response yet...</div>}
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
                    {messages.length > 0
                      ? JSON.stringify(
                          messages.filter((msg) => msg.role === 'assistant'),
                          null,
                          2,
                        )
                      : 'No message data yet...'}
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

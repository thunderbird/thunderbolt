import { createSimulatedFetch, createUIMessageTransform, parseSseLog } from '@/ai/streaming/util'
import { AssistantMessage } from '@/components/chat/assistant-message'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { useLocalStorage } from '@/hooks/use-local-storage'
import { cn } from '@/lib/utils'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ReasoningUIPart, TextUIPart, ToolInvocationUIPart, UIMessage } from 'ai'
import { streamText, wrapLanguageModel } from 'ai'
import { Check, ChevronsUpDown, Play, RotateCcw, Square } from 'lucide-react'
import { useRef, useState } from 'react'

import { defaultMiddleware } from '@/ai/middleware/default'
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

interface SimulatorContentProps {}

function SimulatorContent({}: SimulatorContentProps) {
  const [selectedSse, setSelectedSse] = useLocalStorage('message-simulator-sse', '')
  const [sseLog, setSseLog] = useState(() => {
    const selectedLog = SSE_LOGS.find((log) => log.value === selectedSse)
    return selectedLog?.content || ''
  })
  const [isSimulating, setIsSimulating] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [realtimeMessage, setRealtimeMessage] = useState<UIMessage<
    ReasoningUIPart | ToolInvocationUIPart | TextUIPart,
    { finishReason: string; messageId: string }
  > | null>(null)
  const [open, setOpen] = useState(false)
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
        middleware: defaultMiddleware,
      })

      // Call the Vercel AI SDK streamText helper which gives us a StreamTextResult-like object
      const result = await streamText({
        model: wrappedModel,
        prompt: 'Simulated prompt', // Minimal prompt just to satisfy the SDK API
        abortSignal: signal,
      })

      // -------------------------------------------------------------------
      // Transform the raw chunk stream into UIMessage snapshots using a
      // standard TransformStream, then consume each UIMessage update
      // -------------------------------------------------------------------
      const messageStream = result.fullStream.pipeThrough(createUIMessageTransform())
      const reader = messageStream.getReader()

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          setRealtimeMessage(value as any) // Cast to bypass TypeScript generics mismatch
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
                      disabled={isSimulating}
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

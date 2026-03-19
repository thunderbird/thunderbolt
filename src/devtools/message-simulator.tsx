import { createMockToolSet, createSimulatedFetch, parseEnhancedSseFile, parseSseLog } from '@/ai/streaming/util'
import { AssistantMessage } from '@/components/chat/assistant-message'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { useSettings } from '@/hooks/use-settings'
import { cn } from '@/lib/utils'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, stepCountIs, streamText, wrapLanguageModel } from 'ai'
import { Check, ChevronsUpDown, Play, RotateCcw, Square } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { v7 as uuidv7 } from 'uuid'

import { extractReasoningMiddleware } from 'ai'
import THINK_TAGS_SSE_CONTENT from '../ai/streaming/sse-logs/001-think-tags.sse?raw'
import REASONING_PROPERTY_SSE_CONTENT from '../ai/streaming/sse-logs/002-reasoning-property.sse?raw'
import MALFORMED_TOOL_CALL_THINK_SSE_CONTENT from '../ai/streaming/sse-logs/003-malformed-tool-call-think.sse?raw'
import TOOL_CALL_SSE_CONTENT from '../ai/streaming/sse-logs/004-tool-call.sse?raw'
import START_WITH_REASONING_SSE_CONTENT from '../ai/streaming/sse-logs/005-start-with-reasoning.sse?raw'

// Map of SSE log files to their content
const sseLogFiles = {
  'think-tags': THINK_TAGS_SSE_CONTENT,
  'reasoning-property': REASONING_PROPERTY_SSE_CONTENT,
  'malformed-tool-call-think': MALFORMED_TOOL_CALL_THINK_SSE_CONTENT,
  'tool-call': TOOL_CALL_SSE_CONTENT,
  'start-with-reasoning': START_WITH_REASONING_SSE_CONTENT,
} as const

// Generate SSE logs array from file names with metadata
const sseLogs = Object.entries(sseLogFiles).map(([fileName, content]) => {
  const { metadata } = parseEnhancedSseFile(content)
  return {
    value: fileName,
    label: fileName.charAt(0).toUpperCase() + fileName.slice(1).replace('-', ' '),
    content,
    description: metadata.description,
    metadata,
  }
})

type SimulatorChatProps = {
  sseContent: string
  onStop: () => void
  stopRef: MutableRefObject<(() => void) | null>
}

const SimulatorChat = ({ sseContent, onStop, stopRef }: SimulatorChatProps) => {
  // Generate stable IDs only once when component mounts
  const [chatId] = useState(() => `simulation-${uuidv7()}`)

  // Parse the enhanced SSE file to get metadata and responses
  const { metadata, responses } = parseEnhancedSseFile(sseContent)

  // Use a ref to track call count reliably across AI SDK calls
  const callCountRef = useRef(0)

  // Create a custom fetch function that simulates multi-turn responses
  const customFetch = useCallback(
    Object.assign(
      async (_requestInfo: RequestInfo | URL, init?: RequestInit) => {
        if (!sseContent.trim()) {
          throw new Error('No SSE content')
        }

        // Track which response to use based on call count
        const currentCallCount = callCountRef.current
        callCountRef.current += 1

        // Use the response corresponding to the call count, or last response if we exceed
        const responseIndex = Math.min(currentCallCount, responses.length - 1)
        const currentResponse = responses[responseIndex]

        console.log(
          `[Simulator] Call #${currentCallCount + 1}, using response ${responseIndex + 1}/${responses.length}`,
        )

        // Create a mock fetch that returns the current SSE response
        const chunks = parseSseLog(currentResponse)
        const simulatedFetch = createSimulatedFetch(chunks, {
          initialDelayInMs: metadata.initial_delay_ms || 200,
          chunkDelayInMs: metadata.chunk_delay_ms || 20,
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
          middleware: [
            extractReasoningMiddleware({
              tagName: 'think',
              startWithReasoning: metadata.start_with_reasoning ?? false,
            }),
          ],
        })

        const result = streamText({
          model: wrappedModel,
          prompt: 'Simulated prompt',
          abortSignal: init?.signal || undefined,
          onChunk: (chunk) => {
            console.log('[Simulator] onChunk', chunk)
          },
          onError: (error) => {
            console.error('[Simulator] streamText error:', error)
          },
          onFinish: (message) => {
            console.log('[Simulator] onFinish', message)
          },
          onStepFinish: (step) => {
            console.log('[Simulator] onStepFinish - Step completed:', step)
            console.log('[Simulator] onStepFinish - Tool calls:', step.toolCalls)
            console.log('[Simulator] onStepFinish - Tool results:', step.toolResults)
          },
          stopWhen: stepCountIs(20),
          tools: createMockToolSet(),
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
    [sseContent, metadata, responses],
  )

  const chatHelpers = useChat({
    id: chatId,
    transport: new DefaultChatTransport({ fetch: customFetch }),
    generateId: uuidv7,
    onError: (error) => {
      console.error('Simulation error:', error)
    },
  })

  const { messages, status, stop } = chatHelpers
  const isLoading = status === 'streaming'

  // Auto-start simulation when component mounts
  useEffect(() => {
    // Reset call count for fresh simulation
    callCountRef.current = 0

    const startSimulation = async () => {
      await chatHelpers.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: '<prompt>' }],
      })
    }
    startSimulation()
  }, [])

  // Call onStop when simulation finishes naturally
  useEffect(() => {
    console.log('Status changed:', status, 'Messages:', messages.length, 'IsLoading:', isLoading)
    if ((status === 'ready' || status === 'error') && messages.length > 0 && !isLoading) {
      // Simulation has finished
      console.log('Simulation finished, calling onStop')
      onStop()
    }
  }, [status, messages.length, isLoading, onStop])

  // Call onStop when user stops manually
  const handleStop = () => {
    stop()
    onStop()
  }

  // Expose the stop function to parent via ref
  useEffect(() => {
    stopRef.current = handleStop
    return () => {
      stopRef.current = null
    }
  }, [stopRef])

  return (
    <>
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
                {messages.filter((msg) => msg.role === 'assistant').length === 0 && (
                  <div className="text-muted-foreground">No assistant response yet...</div>
                )}
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
    </>
  )
}

const SimulatorContent = () => {
  const { simulationSse } = useSettings({
    simulation_sse: '',
  })

  const selectedSse = simulationSse.value
  const setSelectedSse = (value: string) => simulationSse.setValue(value)

  const [sseContent, setSseContent] = useState(() => {
    const selectedLog = sseLogs.find((log) => log.value === selectedSse)
    return selectedLog?.content || ''
  })
  const [open, setOpen] = useState(false)
  const [simulationKey, setSimulationKey] = useState<number | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const stopFunctionRef = useRef<(() => void) | null>(null)

  // Parse metadata from current SSE content
  const metadata = (() => {
    if (sseContent.trim()) {
      const { metadata, responses } = parseEnhancedSseFile(sseContent)
      return { ...metadata, responsesCount: responses.length }
    }
    return {}
  })()

  const startSimulation = () => {
    if (!sseContent.trim()) {
      return
    }
    // Create a new simulation key to force re-mount of SimulatorChat
    setSimulationKey(Date.now())
    setIsRunning(true)
  }

  const stopSimulation = () => {
    // Try to call the child's stop function first, then set state
    if (stopFunctionRef.current) {
      stopFunctionRef.current()
    }
    setIsRunning(false)
  }

  const onSimulationFinished = () => {
    // Called when simulation finishes naturally - just update button state
    setIsRunning(false)
  }

  const resetSimulation = () => {
    setSimulationKey(null)
    setIsRunning(false)
    setSseContent('')
    setSelectedSse('')
  }

  const handleSseSelection = (value: string) => {
    const selectedLog = sseLogs.find((log) => log.value === value)
    if (selectedLog) {
      setSelectedSse(value)
      setSseContent(selectedLog.content)
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
                      className="w-[400px] justify-between"
                      disabled={isRunning}
                    >
                      {selectedSse ? sseLogs.find((log) => log.value === selectedSse)?.label : 'Select SSE log...'}
                      <ChevronsUpDown className="opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[400px] p-0">
                    <Command>
                      <CommandInput placeholder="Search SSE logs..." className="h-9" />
                      <CommandList>
                        <CommandEmpty>No SSE log found.</CommandEmpty>
                        <CommandGroup>
                          {sseLogs.map((log) => (
                            <CommandItem key={log.value} value={log.value} onSelect={handleSseSelection}>
                              <span className="font-medium">{log.label}</span>
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

              {/* Scenario Metadata */}
              {Object.keys(metadata).length > 0 && (
                <div className="rounded-md border p-4 bg-muted/50">
                  <h4 className="font-medium mb-3">Scenario Properties</h4>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    {(metadata as any).description && (
                      <>
                        <dt className="font-medium text-muted-foreground">Description:</dt>
                        <dd className="text-foreground">{(metadata as any).description}</dd>
                      </>
                    )}
                    {typeof (metadata as any).start_with_reasoning === 'boolean' && (
                      <>
                        <dt className="font-medium text-muted-foreground">Start with Reasoning:</dt>
                        <dd className="text-foreground">{(metadata as any).start_with_reasoning ? 'Yes' : 'No'}</dd>
                      </>
                    )}
                    {typeof (metadata as any).responsesCount === 'number' && (
                      <>
                        <dt className="font-medium text-muted-foreground">Steps:</dt>
                        <dd className="text-foreground">{(metadata as any).responsesCount}</dd>
                      </>
                    )}
                  </dl>
                </div>
              )}

              <Textarea
                placeholder="SSE content will be processed by the actual streamText function..."
                value={sseContent}
                onChange={(e) => setSseContent(e.target.value)}
                className="min-h-[200px] font-mono text-xs"
                disabled={isRunning}
              />

              <div className="flex gap-2">
                <Button
                  onClick={isRunning ? stopSimulation : startSimulation}
                  disabled={!sseContent.trim()}
                  className="flex items-center gap-2"
                >
                  {isRunning ? (
                    <>
                      <Square size={16} />
                      Stop
                    </>
                  ) : (
                    <>
                      <Play size={16} />
                      Run
                    </>
                  )}
                </Button>

                <Button
                  onClick={resetSimulation}
                  variant="outline"
                  className="flex items-center gap-2"
                  disabled={isRunning}
                >
                  <RotateCcw size={16} />
                  Clear
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Simulation Output */}
          {simulationKey && (
            <SimulatorChat
              key={simulationKey}
              sseContent={sseContent}
              onStop={onSimulationFinished}
              stopRef={stopFunctionRef}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default function MessageSimulatorPage() {
  return <SimulatorContent />
}

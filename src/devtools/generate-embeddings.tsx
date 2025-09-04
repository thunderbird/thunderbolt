import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { DatabaseSingleton } from '@/db/singleton'
import { Indexer } from '@/lib/indexer'
import { useTray } from '@/lib/tray'
import type { EmailMessage } from '@/types'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@radix-ui/react-accordion'
import { Switch } from '@radix-ui/react-switch'
import { AlertCircle, Pause, Play, SkipForward } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export default function GenerateEmbeddingsSection() {
  const db = DatabaseSingleton.instance.db
  const { tray } = useTray()
  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [batchSize, setBatchSize] = useState<number>(1)
  const [status, setStatus] = useState<string>('')
  const [progress, setProgress] = useState<{ processed: number; total: number }>({ processed: 0, total: 0 })
  const indexerRef = useRef<Indexer | null>(null)
  const [useCustomText, setUseCustomText] = useState<boolean>(false)
  const [customText, setCustomText] = useState<string>('')
  const [averageTimePerEmbedding, setAverageTimePerEmbedding] = useState<number>(0)
  const [totalEmbeddingTime, setTotalEmbeddingTime] = useState<number>(0)
  const [totalEmbeddingsProcessed, setTotalEmbeddingsProcessed] = useState<number>(0)
  const [maxBatchTime, setMaxBatchTime] = useState<number>(5000) // 5 seconds default
  const [slowBatches] = useState<Array<{ batchNumber: number; time: number; emails: EmailMessage[] }>>([])
  const [currentOffset, setCurrentOffset] = useState<number>(0)
  const [slowThreads, setSlowThreads] = useState<string[]>([])

  // Update tray title when progress changes
  useEffect(() => {
    if (tray) {
      tray.setTitle(isGenerating ? `${progress.processed} / ${progress.total}` : 'Paused')
    }
  }, [tray, isGenerating, progress.processed, progress.total])

  useEffect(() => {
    // Initialize the indexer
    indexerRef.current = new Indexer({ db, batchSize })

    const fetchCounts = async () => {
      try {
        if (indexerRef.current) {
          await indexerRef.current.updateProgress()
          const status = indexerRef.current.getStatus()
          setProgress({
            total: status.threadCount,
            processed: status.embeddingsCount,
          })

          // Update debug info
          setSlowThreads(status.debug.slowThreads)
          if (status.debug.totalEmbeddingsProcessed > 0) {
            setTotalEmbeddingTime(status.debug.totalEmbeddingTime)
            setTotalEmbeddingsProcessed(status.debug.totalEmbeddingsProcessed)
            setAverageTimePerEmbedding(status.debug.totalEmbeddingTime / status.debug.totalEmbeddingsProcessed)
          }
        }
      } catch (error) {
        console.error('Error fetching counts:', error)
      }
    }

    fetchCounts()
  }, [db, batchSize])

  useEffect(() => {
    // Update indexer batch size when it changes in UI
    if (indexerRef.current) {
      indexerRef.current = new Indexer({ db, batchSize })
      indexerRef.current.updateProgress()
    }
  }, [batchSize, db])

  const handleGenerateEmbeddings = async () => {
    if (!indexerRef.current) return

    setIsGenerating(true)
    setStatus('Generating embeddings...')
    setCurrentOffset(0)
    setTotalEmbeddingTime(0)
    setTotalEmbeddingsProcessed(0)

    try {
      // Start a monitoring interval to update UI
      const monitoringInterval = setInterval(async () => {
        if (indexerRef.current) {
          await indexerRef.current.updateProgress()
          const status = indexerRef.current.getStatus()

          setProgress({
            total: status.threadCount,
            processed: status.embeddingsCount,
          })

          // Update debug info
          setSlowThreads(status.debug.slowThreads)
          if (status.debug.totalEmbeddingsProcessed > 0) {
            setTotalEmbeddingTime(status.debug.totalEmbeddingTime)
            setTotalEmbeddingsProcessed(status.debug.totalEmbeddingsProcessed)
            setAverageTimePerEmbedding(status.debug.totalEmbeddingTime / status.debug.totalEmbeddingsProcessed)
          }

          if (!status.isIndexing) {
            clearInterval(monitoringInterval)
            setIsGenerating(false)
            setStatus('Indexing complete!')
          }
        }
      }, 500)

      // Start the indexing process
      indexerRef.current.indexAll().catch((error) => {
        console.error('Indexing error:', error)
        clearInterval(monitoringInterval)
        setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
        setIsGenerating(false)
      })
    } catch (error) {
      console.error('Error generating embeddings:', error)
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
      setIsGenerating(false)
    }
  }

  const handleStepGeneration = async () => {
    if (isGenerating || !indexerRef.current) return

    setIsGenerating(true)
    setStatus('Processing one batch...')

    try {
      // Process just one batch
      await indexerRef.current.indexNextBatch()
      await indexerRef.current.updateProgress()

      const status = indexerRef.current.getStatus()
      setProgress({
        total: status.threadCount,
        processed: status.embeddingsCount,
      })

      // Update debug info
      setSlowThreads(status.debug.slowThreads)
      if (status.debug.totalEmbeddingsProcessed > 0) {
        setTotalEmbeddingTime(status.debug.totalEmbeddingTime)
        setTotalEmbeddingsProcessed(status.debug.totalEmbeddingsProcessed)
        setAverageTimePerEmbedding(status.debug.totalEmbeddingTime / status.debug.totalEmbeddingsProcessed)
      }

      setStatus('Batch processing complete')
    } catch (error) {
      console.error('Error in step generation:', error)
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsGenerating(false)
    }
  }

  const handleStopGeneration = () => {
    if (indexerRef.current) {
      indexerRef.current.cancel()
      setStatus('Stopping generation after current batch completes...')
    }
  }

  const progressPercentage =
    progress.total > 0 ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generate Embeddings</CardTitle>
        <CardDescription>Generate and store embeddings for email threads</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <Button onClick={handleGenerateEmbeddings} disabled={isGenerating} className="flex items-center gap-2">
              <Play size={16} />
              {isGenerating ? 'Generating...' : 'Start'}
            </Button>
            <Button
              onClick={handleStepGeneration}
              disabled={isGenerating}
              variant="outline"
              className="flex items-center gap-2"
            >
              <SkipForward size={16} />
              Step
            </Button>
            {isGenerating && (
              <Button onClick={handleStopGeneration} variant="destructive" className="flex items-center gap-2">
                <Pause size={16} />
                Stop
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600 dark:text-gray-400">Batch Size:</span>
            <input
              type="number"
              value={batchSize}
              onChange={(e) => setBatchSize(Number(e.target.value))}
              className="w-20 p-1 text-sm border rounded"
              min="1"
              max="100"
              disabled={isGenerating}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 mt-2">
          <span className="text-sm text-gray-600 dark:text-gray-400">Max Batch Time (ms):</span>
          <input
            type="number"
            value={maxBatchTime}
            onChange={(e) => setMaxBatchTime(Number(e.target.value))}
            className="w-24 p-1 text-sm border rounded"
            min="1000"
            disabled={isGenerating}
          />
        </div>

        <div className="flex items-center gap-2 mt-2">
          <Switch
            checked={useCustomText}
            onCheckedChange={setUseCustomText}
            id="custom-text-toggle"
            disabled={isGenerating}
          />
          <label htmlFor="custom-text-toggle" className="text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
            Use custom text instead of thread content
          </label>
        </div>

        {useCustomText && (
          <Textarea
            placeholder="Enter custom text to embed..."
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            className="mt-2"
            rows={3}
            disabled={isGenerating}
          />
        )}

        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-4 overflow-hidden mt-4">
          <div
            className="bg-blue-600 h-4 rounded-full transition-all duration-300 ease-in-out"
            style={{ width: `${progressPercentage}%` }}
          ></div>
        </div>
        <div className="text-sm text-gray-600 dark:text-gray-400 text-center">
          {progress.processed} of {progress.total} threads processed ({progressPercentage}%)
        </div>

        <div className="grid grid-cols-2 gap-4 mt-2">
          <div className="p-3 bg-gray-100 dark:bg-gray-800 rounded-md">
            <div className="text-sm font-medium">Avg. Time per Embedding</div>
            <div className="text-lg font-bold">{averageTimePerEmbedding.toFixed(2)} ms</div>
          </div>
          <div className="p-3 bg-gray-100 dark:bg-gray-800 rounded-md">
            <div className="text-sm font-medium">Current Offset</div>
            <div className="text-lg font-bold">{currentOffset}</div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mt-2">
          <div className="p-3 bg-gray-100 dark:bg-gray-800 rounded-md">
            <div className="text-sm font-medium">Total Embedding Time</div>
            <div className="text-lg font-bold">{totalEmbeddingTime.toFixed(2)} ms</div>
          </div>
          <div className="p-3 bg-gray-100 dark:bg-gray-800 rounded-md">
            <div className="text-sm font-medium">Total Embeddings Processed</div>
            <div className="text-lg font-bold">{totalEmbeddingsProcessed}</div>
          </div>
        </div>

        {status && (
          <div className="mt-4 p-4 bg-gray-100 dark:bg-gray-800 rounded-md">
            <div className="text-sm">{status}</div>
          </div>
        )}

        {slowBatches.length > 0 && (
          <Accordion type="single" collapsible className="mt-4">
            <AccordionItem value="slow-batches">
              <AccordionTrigger className="flex items-center gap-2">
                <AlertCircle size={16} className="text-amber-500" />
                <span>Slow Batches ({slowBatches.length})</span>
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-2">
                  {slowBatches.map((batch, index) => (
                    <div key={index} className="p-2 bg-gray-100 dark:bg-gray-800 rounded border border-amber-300">
                      <div className="flex justify-between">
                        <span className="font-medium">Batch #{batch.batchNumber}</span>
                        <span className="text-amber-500">{batch.time.toFixed(2)} ms</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">{batch.emails.length} emails processed</div>
                      <Accordion type="single" collapsible className="mt-2">
                        <AccordionItem value="email-content">
                          <AccordionTrigger className="text-xs">View Email Content</AccordionTrigger>
                          <AccordionContent>
                            <div className="max-h-60 overflow-y-auto">
                              {batch.emails.map((email, emailIndex) => (
                                <div
                                  key={emailIndex}
                                  className="p-2 border-t border-gray-200 dark:border-gray-700 text-xs"
                                >
                                  <div className="font-medium">Email #{emailIndex + 1}</div>
                                  <pre className="whitespace-pre-wrap mt-1 text-xs overflow-x-auto">
                                    {email.textBody || '(No text body)'}
                                  </pre>
                                </div>
                              ))}
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}

        {slowThreads.length > 0 && (
          <Accordion type="single" collapsible className="mt-4">
            <AccordionItem value="slow-threads">
              <AccordionTrigger className="flex items-center gap-2">
                <AlertCircle size={16} className="text-red-500" />
                <span>Slow Threads ({slowThreads.length})</span>
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-2">
                  {slowThreads.map((threadId, index) => (
                    <div key={index} className="p-2 bg-gray-100 dark:bg-gray-800 rounded border border-red-300">
                      <div className="flex justify-between">
                        <span className="font-medium">Thread ID</span>
                        <span className="text-red-500">{threadId}</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        Processing time exceeded {indexerRef.current?.getStatus().debug.slowThreadThreshold || 1000}ms
                      </div>
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}
      </CardContent>
    </Card>
  )
}

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DatabaseSingleton } from '@/db/singleton'
import { emailMessagesTable, embeddingsTable } from '@/db/tables'
// import { generateBatch } from '@/lib/embeddings'
import { count } from 'drizzle-orm'
import { useEffect, useRef, useState } from 'react'

export default function GenerateEmbeddingsFrontendSection() {
  const db = DatabaseSingleton.instance.db
  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [batchSize, setBatchSize] = useState<number>(10)
  const [status, setStatus] = useState<string>('')
  const [progress, setProgress] = useState<{ embeddings: number; emails: number }>({ embeddings: 0, emails: 0 })
  const stopGenerationRef = useRef<boolean>(false)

  useEffect(() => {
    const fetchProgress = async () => {
      try {
        const [emailsResult] = await db.select({ value: count() }).from(emailMessagesTable)
        const [embeddingsResult] = await db.select({ value: count() }).from(embeddingsTable)

        setProgress({
          emails: emailsResult.value,
          embeddings: embeddingsResult.value,
        })
      } catch (error) {
        console.error('Error fetching progress:', error)
      }
    }

    fetchProgress()
  }, [db])

  const handleGenerateEmbeddings = async () => {
    setIsGenerating(true)
    stopGenerationRef.current = false
    setStatus('Generating embeddings...')
    try {
      let currentProgress = { ...progress }

      while (currentProgress.embeddings < currentProgress.emails && !stopGenerationRef.current) {
        setStatus(
          `Generating batch ${currentProgress.embeddings + 1} to ${Math.min(currentProgress.embeddings + batchSize, currentProgress.emails)}...`,
        )

        // Process a batch
        // const processedCount = await generateBatch(batchSize)
        const processedCount = 0 // TODO: implement generateBatch

        if (processedCount === 0) {
          // No more messages to process
          break
        }

        // Refresh progress after each batch
        const [emailsResult] = await db.select({ value: count() }).from(emailMessagesTable)
        const [embeddingsResult] = await db.select({ value: count() }).from(embeddingsTable)

        currentProgress = {
          emails: emailsResult.value,
          embeddings: embeddingsResult.value,
        }

        setProgress(currentProgress)

        if (stopGenerationRef.current) {
          setStatus('Generation stopped by user.')
          break
        }
      }

      if (!stopGenerationRef.current) {
        setStatus('Embeddings generated successfully!')
      }
    } catch (error) {
      console.error('Error generating embeddings:', error)
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsGenerating(false)
    }
  }

  const handleStopGeneration = () => {
    stopGenerationRef.current = true
    setStatus('Stopping generation after current batch completes...')
  }

  const progressPercentage =
    progress.emails > 0 ? Math.min(100, Math.round((progress.embeddings / progress.emails) * 100)) : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generate Embeddings (Frontend)</CardTitle>
        <CardDescription>Generate embeddings for email messages in the database</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <Button onClick={handleGenerateEmbeddings} disabled={isGenerating}>
              {isGenerating ? 'Generating...' : 'Generate Embeddings'}
            </Button>
            {isGenerating && (
              <Button onClick={handleStopGeneration} variant="destructive">
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
              max="1000"
              disabled={isGenerating}
            />
          </div>
        </div>

        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-4 overflow-hidden">
          <div
            className="bg-blue-600 h-4 rounded-full transition-all duration-300 ease-in-out"
            style={{ width: `${progressPercentage}%` }}
          ></div>
        </div>
        <div className="text-sm text-gray-600 dark:text-gray-400 text-center">
          {progress.embeddings} of {progress.emails} emails have embeddings ({progressPercentage}%)
        </div>

        {status && (
          <div className="mt-4 p-4 bg-gray-100 dark:bg-gray-800 rounded-md">
            <div className="text-sm">{status}</div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

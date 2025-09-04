import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DatabaseSingleton } from '@/db/singleton'
import { emailMessagesTable } from '@/db/tables'
// import { getEmbedding } from '@/lib/embeddings'
import type { EmailMessage } from '@/types'
import { useEffect, useRef, useState } from 'react'

export default function GenerateEmbeddingsFrontendNoDatabaseSection() {
  const db = DatabaseSingleton.instance.db
  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [batchSize, setBatchSize] = useState<number>(10)
  const [status, setStatus] = useState<string>('')
  const [progress, setProgress] = useState<{ processed: number; total: number }>({ processed: 0, total: 0 })
  const stopGenerationRef = useRef<boolean>(false)
  const [emails, setEmails] = useState<EmailMessage[]>([])

  useEffect(() => {
    const fetchEmails = async () => {
      try {
        // Fetch up to 500 emails
        const emailsResult = await db.select().from(emailMessagesTable).limit(500)
        setEmails(emailsResult)
        setProgress({
          total: emailsResult.length,
          processed: 0,
        })
      } catch (error) {
        console.error('Error fetching emails:', error)
      }
    }

    fetchEmails()
  }, [db])

  const handleGenerateEmbeddings = async () => {
    setIsGenerating(true)
    stopGenerationRef.current = false
    setStatus('Generating embeddings...')
    try {
      let processed = 0

      for (let i = 0; i < emails.length; i++) {
        if (stopGenerationRef.current) {
          setStatus('Generation stopped by user.')
          break
        }

        const email = emails[i]
        setStatus(`Processing email ${i + 1} of ${emails.length}...`)

        // Get the text content to embed
        const textToEmbed = email.textBody

        if (textToEmbed) {
          // Just get the embedding without saving to database
          // await getEmbedding(textToEmbed)
          // TODO: implement getEmbedding
          processed++

          setProgress({
            total: emails.length,
            processed: processed,
          })
        }

        // Process in small batches to allow UI updates
        if (i % batchSize === 0) {
          // Small delay to allow UI to update
          await new Promise((resolve) => setTimeout(resolve, 10))
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
    setStatus('Stopping generation after current email completes...')
  }

  const progressPercentage =
    progress.total > 0 ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generate Embeddings (No Database)</CardTitle>
        <CardDescription>Generate embeddings for email messages without saving to database</CardDescription>
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
              max="100"
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
          {progress.processed} of {progress.total} emails processed ({progressPercentage}%)
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

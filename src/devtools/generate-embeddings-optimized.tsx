import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { DatabaseSingleton } from '@/db/singleton'
import { emailMessagesTable } from '@/db/tables'
// import { getEmbeddings } from '@/lib/embeddings'
import type { EmailMessage } from '@/types'
import { useEffect, useRef, useState } from 'react'

// Function to remove quoted text from emails
const removeQuotedText = (emailText: string): string => {
  return emailText.replace(/^([\s\S]*?)(?:From:|On\s+.*\s+wrote:|\n>)[\s\S]*$/m, '$1').trim()
}

export default function GenerateEmbeddingsOptimizedSection() {
  const db = DatabaseSingleton.instance.db
  const [isGenerating, setIsGenerating] = useState<boolean>(false)
  const [batchSize, setBatchSize] = useState<number>(10)
  const [status, setStatus] = useState<string>('')
  const [progress, setProgress] = useState<{ processed: number; total: number }>({ processed: 0, total: 0 })
  const stopGenerationRef = useRef<boolean>(false)
  const [emails, setEmails] = useState<EmailMessage[]>([])
  const [msPerMessage, setMsPerMessage] = useState<number>(0)
  const [useCustomText, setUseCustomText] = useState<boolean>(false)
  const [customText, setCustomText] = useState<string>('')

  useEffect(() => {
    const fetchEmails = async () => {
      try {
        // Fetch up to 1000 emails
        const emailsResult = await db.select().from(emailMessagesTable).limit(1000)
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

  const processBatch = async (startIndex: number) => {
    if (startIndex >= emails.length || stopGenerationRef.current) {
      return 0
    }

    const endIndex = Math.min(startIndex + batchSize, emails.length)
    const batch = emails.slice(startIndex, endIndex)

    setStatus(`Processing batch ${startIndex + 1}-${endIndex} of ${emails.length}...`)

    // Extract text bodies for embedding or use custom text
    const textsToEmbed =
      useCustomText && customText
        ? Array(batch.length).fill(customText)
        : batch.map((email) => removeQuotedText(email.textBody || ''))

    console.log(textsToEmbed)

    // Time the batch processing
    const startTime = performance.now()

    // Get embeddings for the batch
    // await getEmbeddings(textsToEmbed)
    // TODO: implement getEmbeddings

    const endTime = performance.now()
    const batchTime = endTime - startTime
    const avgTimePerMessage = batchTime / batch.length

    setMsPerMessage(avgTimePerMessage)

    return endIndex - startIndex
  }

  const handleGenerateEmbeddings = async () => {
    setIsGenerating(true)
    stopGenerationRef.current = false
    setStatus('Generating embeddings...')

    try {
      let processed = progress.processed

      for (let i = processed; i < emails.length; i += batchSize) {
        if (stopGenerationRef.current) {
          setStatus('Generation stopped by user.')
          break
        }

        const processedCount = await processBatch(i)
        processed += processedCount

        setProgress({
          total: emails.length,
          processed: processed,
        })

        // Small delay to allow UI to update
        await new Promise((resolve) => setTimeout(resolve, 10))
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

  const handleStepGeneration = async () => {
    if (isGenerating) return

    setIsGenerating(true)
    stopGenerationRef.current = false

    try {
      const currentProcessed = progress.processed
      if (currentProcessed < emails.length) {
        setStatus(`Processing single batch starting at ${currentProcessed + 1}...`)

        const processedCount = await processBatch(currentProcessed)

        setProgress({
          total: emails.length,
          processed: currentProcessed + processedCount,
        })

        setStatus(`Batch complete. Processed ${processedCount} emails.`)
      } else {
        setStatus('All emails have been processed.')
      }
    } catch (error) {
      console.error('Error in step generation:', error)
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
    progress.total > 0 ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generate Embeddings (Optimized)</CardTitle>
        <CardDescription>Generate embeddings for email messages using optimized batch processing</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <Button onClick={handleGenerateEmbeddings} disabled={isGenerating}>
              {isGenerating ? 'Generating...' : 'Generate Embeddings'}
            </Button>
            <Button onClick={handleStepGeneration} disabled={isGenerating || progress.processed >= progress.total}>
              Step
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

        <div className="flex items-center space-x-2 mt-2">
          <Switch
            id="custom-text-toggle"
            checked={useCustomText}
            onCheckedChange={setUseCustomText}
            disabled={isGenerating}
          />
          <Label htmlFor="custom-text-toggle">Use custom text for performance testing</Label>
        </div>

        {useCustomText && (
          <Textarea
            placeholder="Enter custom text to embed repeatedly..."
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            className="min-h-[100px]"
            disabled={isGenerating}
          />
        )}

        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-4 overflow-hidden">
          <div
            className="bg-blue-600 h-4 rounded-full transition-all duration-300 ease-in-out"
            style={{ width: `${progressPercentage}%` }}
          ></div>
        </div>
        <div className="text-sm text-gray-600 dark:text-gray-400 text-center">
          {progress.processed} of {progress.total} emails processed ({progressPercentage}%)
        </div>

        {msPerMessage > 0 && (
          <div className="text-sm text-gray-600 dark:text-gray-400 text-center">
            Average processing time: {msPerMessage.toFixed(2)} ms per message
          </div>
        )}

        {status && (
          <div className="mt-4 p-4 bg-gray-100 dark:bg-gray-800 rounded-md">
            <div className="text-sm">{status}</div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

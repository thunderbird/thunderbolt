import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DatabaseSingleton } from '@/db/singleton'
import { emailMessagesTable } from '@/db/tables'
import { EmailThreader } from '@/lib/email'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@radix-ui/react-accordion'
import { count, sql } from 'drizzle-orm'
import { AlertCircle, Pause, Play, SkipForward } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export default function GenerateThreadsSection() {
  const db = DatabaseSingleton.instance.db
  const [isProcessing, setIsProcessing] = useState<boolean>(false)
  const [batchSize, setBatchSize] = useState<number>(10)
  const [status, setStatus] = useState<string>('')
  const [progress, setProgress] = useState<{ processed: number; total: number }>({ processed: 0, total: 0 })
  const [threaderStatus, setThreaderStatus] = useState<{
    threadsCreated: number
    messagesProcessed: number
    isProcessing: boolean
  }>({
    threadsCreated: 0,
    messagesProcessed: 0,
    isProcessing: false,
  })
  const threaderRef = useRef<EmailThreader | null>(null)
  const [errors, setErrors] = useState<Array<{ emailId: string; error: string }>>([])

  useEffect(() => {
    // Initialize the threader
    threaderRef.current = new EmailThreader(db, batchSize)

    const fetchCounts = async () => {
      try {
        // Get total count of emails
        const totalEmails = await db.select({ count: count() }).from(emailMessagesTable).get()

        // Get count of emails with thread IDs
        const processedEmails = await db
          .select({ count: count() })
          .from(emailMessagesTable)
          .where(sql`${emailMessagesTable.emailThreadId} IS NOT NULL`)
          .get()

        setProgress({
          total: totalEmails?.count || 0,
          processed: processedEmails?.count || 0,
        })
      } catch (error) {
        console.error('Error fetching counts:', error)
        setStatus(`Error fetching counts: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    fetchCounts()
  }, [db, batchSize])

  useEffect(() => {
    // Update threader batch size when it changes in UI
    if (threaderRef.current) {
      threaderRef.current = new EmailThreader(db, batchSize)
    }
  }, [batchSize, db])

  const handleProcessThreads = async () => {
    if (!threaderRef.current) return

    setIsProcessing(true)
    setStatus('Processing email threads...')
    setErrors([])

    try {
      // Start a monitoring interval to update UI
      const monitoringInterval = setInterval(async () => {
        try {
          // Get total count of emails
          const totalEmails = await db.select({ count: count() }).from(emailMessagesTable).get()

          // Get count of emails with thread IDs
          const processedEmails = await db
            .select({ count: count() })
            .from(emailMessagesTable)
            .where(sql`${emailMessagesTable.emailThreadId} IS NOT NULL`)
            .get()

          setProgress({
            total: totalEmails?.count || 0,
            processed: processedEmails?.count || 0,
          })

          // Update threader status
          if (threaderRef.current) {
            setThreaderStatus(threaderRef.current.getStatus())
          }

          // Check if processing is complete
          if (totalEmails?.count === processedEmails?.count) {
            clearInterval(monitoringInterval)
            setIsProcessing(false)
            setStatus('Thread processing complete!')
          }
        } catch (error) {
          console.error('Error updating progress:', error)
        }
      }, 500)

      // Start the threading process
      threaderRef.current
        .processEmails()
        .then(() => {
          clearInterval(monitoringInterval)
          setIsProcessing(false)
          setStatus('Thread processing complete!')
          // Get final status
          if (threaderRef.current) {
            setThreaderStatus(threaderRef.current.getStatus())
          }
        })
        .catch((error) => {
          console.error('Threading error:', error)
          clearInterval(monitoringInterval)
          setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
          setIsProcessing(false)
        })
    } catch (error) {
      console.error('Error processing threads:', error)
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
      setIsProcessing(false)
    }
  }

  const handleStepProcessing = async () => {
    if (isProcessing || !threaderRef.current) return

    setIsProcessing(true)
    setStatus('Processing one batch...')

    try {
      // Process just one batch by creating a new threader with batch size 1
      const stepThreader = new EmailThreader(db, 1)
      await stepThreader.processEmails()

      // Update counts after processing
      const totalEmails = await db.select({ count: count() }).from(emailMessagesTable).get()
      const processedEmails = await db
        .select({ count: count() })
        .from(emailMessagesTable)
        .where(sql`${emailMessagesTable.emailThreadId} IS NOT NULL`)
        .get()

      setProgress({
        total: totalEmails?.count || 0,
        processed: processedEmails?.count || 0,
      })

      // Get status from the step threader
      setThreaderStatus(stepThreader.getStatus())
      setStatus('Batch processing complete')
    } catch (error) {
      console.error('Error in step processing:', error)
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsProcessing(false)
    }
  }

  const handleStopProcessing = () => {
    if (threaderRef.current) {
      threaderRef.current.cancel()
      setStatus('Stopping processing after current batch completes...')
    }
  }

  const progressPercentage =
    progress.total > 0 ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generate Email Threads</CardTitle>
        <CardDescription>Process emails and organize them into conversation threads</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <Button onClick={handleProcessThreads} disabled={isProcessing} className="flex items-center gap-2">
              <Play size={16} />
              {isProcessing ? 'Processing...' : 'Start'}
            </Button>
            <Button
              onClick={handleStepProcessing}
              disabled={isProcessing}
              variant="outline"
              className="flex items-center gap-2"
            >
              <SkipForward size={16} />
              Step
            </Button>
            {isProcessing && (
              <Button onClick={handleStopProcessing} variant="destructive" className="flex items-center gap-2">
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
              disabled={isProcessing}
            />
          </div>
        </div>

        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-4 overflow-hidden mt-4">
          <div
            className="bg-blue-600 h-4 rounded-full transition-all duration-300 ease-in-out"
            style={{ width: `${progressPercentage}%` }}
          ></div>
        </div>
        <div className="text-sm text-gray-600 dark:text-gray-400 text-center">
          {progress.processed} of {progress.total} emails processed ({progressPercentage}%)
        </div>

        <div className="grid grid-cols-3 gap-4 mt-2">
          <div className="p-3 bg-gray-100 dark:bg-gray-800 rounded-md">
            <div className="text-sm font-medium">Total Emails</div>
            <div className="text-lg font-bold">{progress.total}</div>
          </div>
          <div className="p-3 bg-gray-100 dark:bg-gray-800 rounded-md">
            <div className="text-sm font-medium">Emails in Threads</div>
            <div className="text-lg font-bold">{progress.processed}</div>
          </div>
          <div className="p-3 bg-gray-100 dark:bg-gray-800 rounded-md">
            <div className="text-sm font-medium">Threads Created</div>
            <div className="text-lg font-bold">{threaderStatus.threadsCreated}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 mt-2">
          <div className="p-3 bg-gray-100 dark:bg-gray-800 rounded-md">
            <div className="text-sm font-medium">Messages Processed (Current Session)</div>
            <div className="text-lg font-bold">{threaderStatus.messagesProcessed}</div>
          </div>
        </div>

        {status && (
          <div className="mt-4 p-4 bg-gray-100 dark:bg-gray-800 rounded-md">
            <div className="text-sm">{status}</div>
          </div>
        )}

        {errors.length > 0 && (
          <Accordion type="single" collapsible className="mt-4">
            <AccordionItem value="errors">
              <AccordionTrigger className="flex items-center gap-2">
                <AlertCircle size={16} className="text-red-500" />
                <span>Errors ({errors.length})</span>
              </AccordionTrigger>
              <AccordionContent>
                <div className="space-y-2">
                  {errors.map((error, index) => (
                    <div key={index} className="p-2 bg-gray-100 dark:bg-gray-800 rounded border border-red-300">
                      <div className="flex justify-between">
                        <span className="font-medium">Email ID</span>
                        <span className="text-red-500">{error.emailId}</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">{error.error}</div>
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

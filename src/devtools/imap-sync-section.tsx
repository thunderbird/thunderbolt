import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useDrizzle } from '@/db/provider'
import { emailMessagesTable } from '@/db/schema'
import { useImapSync } from '@/sync'
import { count } from 'drizzle-orm'
import { useEffect, useState } from 'react'

export default function ImapSyncSection() {
  const imapSync = useImapSync()
  const { db } = useDrizzle()
  const [messageCount, setMessageCount] = useState<number>(0)
  const [isPolling, setIsPolling] = useState<boolean>(false)
  const [isLoading, setIsLoading] = useState<boolean>(false)

  const handleSync = async () => {
    setIsLoading(true)
    try {
      await imapSync.syncMailbox('INBOX')
      fetchMessageCount()
    } catch (error) {
      console.error('Error syncing mailbox:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const fetchMessageCount = async () => {
    try {
      const result = await db.select({ value: count() }).from(emailMessagesTable)
      setMessageCount(result[0]?.value || 0)
    } catch (error) {
      console.error('Error fetching message count:', error)
    }
  }

  useEffect(() => {
    // Fetch initial message count
    fetchMessageCount()

    // Set up polling interval if enabled
    let intervalId: number | undefined

    if (isPolling) {
      intervalId = window.setInterval(() => {
        fetchMessageCount()
      }, 10000) // 10 seconds
    }

    // Clean up interval on unmount or when polling changes
    return () => {
      if (intervalId) {
        window.clearInterval(intervalId)
      }
    }
  }, [isPolling])

  return (
    <Card>
      <CardHeader>
        <CardTitle>IMAP Sync</CardTitle>
        <CardDescription>Manage IMAP synchronization and view message counts</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <Button onClick={handleSync} disabled={isLoading}>
            {isLoading ? 'Syncing...' : 'Sync IMAP'}
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600 dark:text-gray-400">Enable Polling:</span>
            <Switch checked={isPolling} onCheckedChange={setIsPolling} aria-label="Toggle polling" />
          </div>
        </div>

        <div className="mt-4 p-4 bg-gray-100 dark:bg-gray-800 rounded-md">
          <div className="flex items-center justify-between">
            <span className="font-medium">Messages:</span>
            <span className="font-bold">{messageCount}</span>
          </div>
          <div className="text-xs text-gray-500 mt-1">{isPolling ? 'Polling every 10 seconds' : 'Polling disabled'}</div>
        </div>
      </CardContent>
    </Card>
  )
}

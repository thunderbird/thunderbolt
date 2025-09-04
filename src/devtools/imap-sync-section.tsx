import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { DatabaseSingleton } from '@/db/singleton'
import { ImapSyncer } from '@/imap/sync'
import { Pause, Play, SkipForward } from 'lucide-react'
import { useEffect, useState, type ChangeEvent } from 'react'

export default function ImapSyncSection() {
  const db = DatabaseSingleton.instance.db
  const [syncer, setSyncer] = useState<ImapSyncer | null>(null)
  const [status, setStatus] = useState({
    messagesProcessed: 0,
    messagesSynced: 0,
    totalMessages: 0,
    isSyncing: false,
    progress: 0,
  })
  const [mailbox, setMailbox] = useState('All Mail')
  const [pageSize, setPageSize] = useState(50)
  const [syncSince, setSyncSince] = useState<Date | undefined>(undefined)
  const [syncSinceInput, setSyncSinceInput] = useState('')

  // Initialize the syncer when db is available
  useEffect(() => {
    if (db) {
      const newSyncer = new ImapSyncer(db, mailbox, pageSize)
      setSyncer(newSyncer)
    }
  }, [db, mailbox, pageSize])

  // Update status periodically when syncing
  useEffect(() => {
    if (!syncer) return

    const updateStatus = () => {
      setStatus(syncer.getStatus())
    }

    const interval = setInterval(updateStatus, 500)
    updateStatus() // Initial update

    return () => clearInterval(interval)
  }, [syncer])

  const handleStartSync = async () => {
    if (!syncer) return
    try {
      await syncer.syncMailbox(syncSince)
    } catch (error) {
      console.error('Sync failed:', error)
    }
  }

  const handleCancelSync = () => {
    if (syncer) {
      syncer.cancel()
    }
  }

  const handleStepSync = async () => {
    if (!syncer || status.isSyncing) return
    try {
      await syncer.syncPage(1, pageSize, syncSince)
    } catch (error) {
      console.error('Step sync failed:', error)
    }
  }

  const handleSyncSinceChange = (e: ChangeEvent<HTMLInputElement>) => {
    setSyncSinceInput(e.target.value)
    if (e.target.value) {
      setSyncSince(new Date(e.target.value))
    } else {
      setSyncSince(undefined)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>IMAP Sync</CardTitle>
        <CardDescription>Sync emails from your IMAP server</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Mailbox</label>
              <input
                type="text"
                className="w-full p-2 border rounded"
                value={mailbox}
                onChange={(e) => setMailbox(e.target.value)}
                disabled={status.isSyncing}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Page Size</label>
              <input
                type="number"
                className="w-full p-2 border rounded"
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                disabled={status.isSyncing}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Sync Since (optional)</label>
            <input
              type="date"
              className="w-full p-2 border rounded"
              value={syncSinceInput}
              onChange={handleSyncSinceChange}
              disabled={status.isSyncing}
            />
          </div>

          <div className="flex justify-between items-center">
            <div>
              <p className="text-sm">
                Messages: {status.messagesSynced} / {status.totalMessages || '?'}
              </p>
            </div>
            <div className="flex gap-2">
              {status.isSyncing ? (
                <Button variant="destructive" onClick={handleCancelSync} className="flex items-center gap-2">
                  <Pause size={16} />
                  Cancel Sync
                </Button>
              ) : (
                <>
                  <Button onClick={handleStartSync} className="flex items-center gap-2">
                    <Play size={16} />
                    Start Sync
                  </Button>
                  <Button onClick={handleStepSync} variant="outline" className="flex items-center gap-2">
                    <SkipForward size={16} />
                    Step
                  </Button>
                </>
              )}
            </div>
          </div>

          {status.isSyncing && <Progress value={status.progress} className="w-full" />}
        </div>
      </CardContent>
    </Card>
  )
}

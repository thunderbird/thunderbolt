import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useDrizzle } from '@/db/provider'
import { emailMessagesTable, embeddingsTable } from '@/db/schema'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'

export default function ResetEmailMessagesSection() {
  const [status, setStatus] = useState<string>('')
  const { db } = useDrizzle()

  const resetMutation = useMutation({
    mutationFn: async () => {
      // Delete all rows from email_messages and embeddings tables
      await db.delete(emailMessagesTable).execute()
      await db.delete(embeddingsTable).execute()
      return true
    },
    onSuccess: () => {
      setStatus('Successfully deleted all email messages and embeddings.')
    },
    onError: (error) => {
      console.error('Error resetting data:', error)
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
    },
  })

  const handleReset = async () => {
    setStatus('Deleting all email messages and embeddings...')
    resetMutation.mutate()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset Email Data</CardTitle>
        <CardDescription>Delete all email messages and embeddings from the database</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <Button onClick={handleReset} disabled={resetMutation.isPending} variant="destructive">
              {resetMutation.isPending ? 'Deleting...' : 'Delete All Email Data'}
            </Button>
          </div>
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

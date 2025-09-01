import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useImap } from '@/imap/provider'
import { Inbox, RefreshCw } from 'lucide-react'
import { useState } from 'react'

type MailboxData = Record<string, number>

export default function ImapMailboxesSection() {
  const { client } = useImap()
  const [mailboxes, setMailboxes] = useState<MailboxData>({})
  const [isLoading, setIsLoading] = useState<boolean>(false)

  const fetchMailboxes = async () => {
    setIsLoading(true)
    try {
      const result = await client.listMailboxes()
      setMailboxes(result)
    } catch (error) {
      console.error('Error fetching mailboxes:', error)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>IMAP Mailboxes</CardTitle>
        <CardDescription>View available mailboxes and message counts</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Button onClick={fetchMailboxes} disabled={isLoading} className="w-fit">
          {isLoading ? (
            <>
              <RefreshCw className="size-4 mr-2 animate-spin" />
              Loading...
            </>
          ) : (
            'Check Mailboxes'
          )}
        </Button>

        {Object.keys(mailboxes).length > 0 ? (
          <div className="grid gap-2 mt-2">
            {Object.entries(mailboxes)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, count]) => (
                <div
                  key={name}
                  className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Inbox className="size-4 text-blue-500" />
                    <span className="font-medium">{name}</span>
                  </div>
                  <span className="bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-2 py-1 rounded-full text-xs font-medium">
                    {count} {count === 1 ? 'message' : 'messages'}
                  </span>
                </div>
              ))}
          </div>
        ) : (
          <div className="text-center p-8 text-gray-500">
            {isLoading ? <p>Loading mailboxes...</p> : <p>Click the button above to check your mailboxes</p>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

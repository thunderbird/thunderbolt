import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useDatabase } from '@/hooks/use-database'
import { emailMessagesTable } from '@/db/tables'
import { formatDate } from '@/lib/utils'
import { useSideview } from '@/sideview/provider'
import { EmailMessageWithAddresses } from '@/types'
import { useQuery } from '@tanstack/react-query'
import { eq, or } from 'drizzle-orm'
import { Loader2, Mail } from 'lucide-react'

interface ChatMessagePreviewProps {
  imapId?: string
  messageId?: string
}

export function ChatMessagePreview({ messageId, imapId }: ChatMessagePreviewProps) {
  if (!messageId && !imapId) throw new Error('Either messageId or imapId must be provided')

  const { db } = useDatabase()
  const { setSideview } = useSideview()

  const { data: message } = useQuery<EmailMessageWithAddresses>({
    queryKey: ['messages', messageId, imapId],
    queryFn: async () => {
      const message = await db.query.emailMessagesTable.findFirst({
        where: or(
          messageId ? eq(emailMessagesTable.id, messageId) : undefined,
          imapId ? eq(emailMessagesTable.imapId, imapId) : undefined,
        ),
        with: {
          sender: true,
          recipients: {
            with: {
              address: true,
            },
          },
        },
      })

      if (!message) throw new Error('Message not found')
      return message
    },
  })

  const handleClick = () => {
    if (message) setSideview('message', message.id)
  }

  return (
    <Card onClick={handleClick} className="cursor-pointer hover:bg-muted transition-colors">
      <CardHeader>
        {!message ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
          </div>
        ) : (
          <>
            <CardTitle className="text-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Mail className="h-3 w-3 shrink-0" />
                  <span className="truncate">{message.sender.name || message.sender.address}</span>
                </div>
                <span className="shrink-0 ml-2">{formatDate(message.sentAt)}</span>
              </div>
            </CardTitle>
            <CardDescription className="text-xs">{message.textBody.slice(0, 100)}</CardDescription>
          </>
        )}
      </CardHeader>
      {/* <CardContent>
        <p>Card Content</p>
      </CardContent>
      <CardFooter>
        <p>Card Footer</p>
      </CardFooter> */}
    </Card>
  )
}

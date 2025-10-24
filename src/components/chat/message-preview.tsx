import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDate } from '@/lib/utils'
import { useSideview } from '@/content-view/context'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Mail } from 'lucide-react'

interface ChatMessagePreviewProps {
  imapId?: string
  messageId?: string
}

export function ChatMessagePreview({ messageId, imapId }: ChatMessagePreviewProps) {
  if (!messageId && !imapId) throw new Error('Either messageId or imapId must be provided')

  const { setSideview } = useSideview()

  const { data: message } = useQuery<any>({
    queryKey: ['messages', messageId, imapId],
    queryFn: async () => {
      if (messageId) {
        // @todo re-implement this
        return null
      } else if (imapId) {
        // @todo re-implement this
        return null
      }
      throw new Error('Either messageId or imapId must be provided')
    },
    enabled: !!(messageId || imapId),
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

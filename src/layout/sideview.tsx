import {
  getEmailThreadByIdWithMessages,
  getEmailThreadByMessageIdWithMessages,
  getEmailThreadByMessageImapIdWithMessages,
} from '@/lib/dal'
import { useSideview } from '@/sideview/provider'
import { EmailThreadView } from '@/sideview/thread'
import { useQuery } from '@tanstack/react-query'

export function Sideview() {
  const { sideviewId, sideviewType } = useSideview()

  console.log('sideviewType', sideviewType, sideviewId)

  const { data: object } = useQuery({
    queryKey: ['sideview', sideviewType, sideviewId],
    queryFn: async () => {
      if (!sideviewId || !sideviewType) return null

      switch (sideviewType) {
        case 'message':
          return await getEmailThreadByMessageIdWithMessages(sideviewId)
        case 'imap':
          return await getEmailThreadByMessageImapIdWithMessages(sideviewId)
        case 'thread':
          return await getEmailThreadByIdWithMessages(sideviewId)
        default:
          return null
      }
    },
    enabled: !!sideviewId && !!sideviewType,
  })

  switch (sideviewType) {
    case 'imap':
      return (
        <div>
          IMAP {object?.id} {object?.messages.length}
        </div>
      )
    case 'message':
      return <EmailThreadView />
    case 'thread':
      return <EmailThreadView />
    default:
      return <div>Unsupported sideview type</div>
  }
}

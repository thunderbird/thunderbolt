import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useQuery } from '@tanstack/react-query'
import { ArrowRightToLine, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { useState } from 'react'
import { useSideview } from './context'

export function EmailThreadView() {
  const [expandAll, setExpandAll] = useState<boolean | null>(null)
  const { sideviewId, sideviewType: _, setSideview } = useSideview()

  const { data: thread, isLoading } = useQuery({
    queryKey: ['thread', sideviewId],
    queryFn: async () => {
      if (!sideviewId) return null

      // @todo re-implement this

      // if (sideviewType === 'thread') {
      //   return await getEmailThreadWithMessages(sideviewId)
      // }

      // if (sideviewType === 'message') {
      //   return await getEmailThreadByMessageIdWithMessages(sideviewId)
      // }

      return null
    },
    enabled: sideviewId !== null,
  })

  const onClose = () => {
    setSideview(null, null)
  }

  if (!thread) {
    return <div className="p-4">Thread not found</div>
  }

  if (isLoading) {
    return (
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between mb-2">
          <Skeleton className="h-6 w-3/4" />
          <div className="flex gap-1">
            <Skeleton className="h-8 w-8 rounded-md" />
            <Skeleton className="h-8 w-8 rounded-md" />
          </div>
        </div>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }

  if (!thread) {
    return <div className="p-4">Thread not found</div>
  }

  return (
    <div className="flex flex-col gap-4 px-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold truncate px-2">Email Thread Title</h2>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" onClick={() => setExpandAll(expandAll === null ? true : !expandAll)}>
            {!expandAll ? <ChevronsUpDown /> : <ChevronsDownUp />}
          </Button>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <ArrowRightToLine />
          </Button>
        </div>
      </div>
      {/* @todo re-implement this */}
      {/* {thread.messages.map((message) => (
        <EmailMessageView key={message.id} message={message} isOpen={expandAll === true} />
      ))} */}
    </div>
  )
}

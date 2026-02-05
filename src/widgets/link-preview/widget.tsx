import { Card, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useMessageCache } from '@/hooks/use-message-cache'
import { useSettings } from '@/hooks/use-settings'
import { fetchLinkPreview } from '@/integrations/thunderbolt-pro/api'
import { LinkChip, LinkPreview } from './display'
import { getHostname } from './utils'

type LinkPreviewWidgetProps = {
  url: string
  messageId: string
}

type LinkPreviewMetadata = {
  title: string | null
  description: string | null
  image: string | null
  imageData?: string | null
}

export const LinkPreviewSkeleton = () => {
  return (
    <div className="my-4">
      <Card className="flex-row flex p-0 gap-0 rounded-lg overflow-hidden">
        <Skeleton className="h-24 w-24 flex-shrink-0 rounded-none" />
        <CardHeader className="flex-1 flex flex-col pl-4 py-4">
          <Skeleton className="h-5 w-3/4 mb-2" />
          <Skeleton className="h-2 w-full" />
        </CardHeader>
      </Card>
    </div>
  )
}

export const LinkPreviewWidget = ({ url, messageId }: LinkPreviewWidgetProps) => {
  const { cloudUrl } = useSettings({ cloud_url: 'http://localhost:8000/v1' })

  // Use message cache hook - it handles checking cache and fetching if needed
  const { data, isLoading, error } = useMessageCache<LinkPreviewMetadata>({
    messageId,
    cacheKey: ['linkPreview', url],
    fetchFn: async () => {
      const preview = await fetchLinkPreview({ url })
      return {
        title: preview.title,
        description: preview.description,
        image: preview.image,
        imageData: preview.imageData,
      }
    },
  })

  if (isLoading) {
    return <LinkPreviewSkeleton />
  }

  if (error || !data) {
    return <LinkChip url={url} />
  }

  const isEmpty = !data.title && !data.description && !data.image
  if (isEmpty) {
    return <LinkChip url={url} />
  }

  // Use inlined image data when available, otherwise proxy through the backend for privacy
  const imageUrl = data.imageData
    ? data.imageData
    : data.image && cloudUrl.value
      ? `${cloudUrl.value}/pro/proxy/${encodeURIComponent(data.image)}`
      : null

  return (
    <LinkPreview title={data.title || getHostname(url)} description={data.description} url={url} image={imageUrl} />
  )
}

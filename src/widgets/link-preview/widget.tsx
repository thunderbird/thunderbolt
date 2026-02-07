import { Card, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useMessageCache } from '@/hooks/use-message-cache'
import { useSettings } from '@/hooks/use-settings'
import { fetchLinkPreview } from '@/integrations/thunderbolt-pro/api'
import { LinkPreview } from './display'
import { getHostname } from './utils'

type LinkPreviewWidgetProps = {
  url: string
  messageId: string
}

type LinkPreviewMetadata = {
  title: string | null
  description: string | null
  image: string | null
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

  // Fetch metadata which includes the extracted image URL
  const metadataQuery = useMessageCache<LinkPreviewMetadata>({
    messageId,
    cacheKey: ['linkPreview', url],
    fetchFn: async () => {
      const preview = await fetchLinkPreview({ url })
      return {
        title: preview.title,
        description: preview.description,
        image: preview.image,
      }
    },
  })

  const { data, isLoading, error } = metadataQuery

  // Construct image URL from metadata when available (uses optimized proxy-image endpoint)
  // This eliminates duplicate page fetches - the metadata endpoint already extracted the image URL
  const imageUrl =
    data?.image && cloudUrl.value && cloudUrl.value.trim()
      ? `${cloudUrl.value}/pro/link-preview/proxy-image/${encodeURIComponent(data.image)}`
      : null

  if (isLoading) {
    return <LinkPreviewSkeleton />
  }

  // Show minimal preview card when there's an error or no metadata
  // This is more visually consistent than the tiny chip
  if (error || !data) {
    return <LinkPreview title={getHostname(url)} description={null} url={url} image={null} />
  }

  const isEmpty = !data.title && !data.description && !data.image
  if (isEmpty) {
    return <LinkPreview title={getHostname(url)} description={null} url={url} image={null} />
  }

  // Ensure title is never null for CardTitle component
  const displayTitle = data.title || getHostname(url)

  return <LinkPreview title={displayTitle} description={data.description} url={url} image={imageUrl} />
}

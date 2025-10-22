import { Card, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useMessageCache } from '@/hooks/use-message-cache'
import { useSettings } from '@/hooks/use-settings'
import { fetchLinkPreview } from '@/integrations/thunderbolt-pro/api'
import { LinkPreview } from './display'

type LinkPreviewWidgetProps = {
  url: string
  messageId: string
}

type LinkPreviewMetadata = {
  title: string
  description: string
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
  const { cloudUrl } = useSettings({ cloud_url: String })

  // Use message cache hook - it handles checking cache and fetching if needed
  const { data, isLoading, error } = useMessageCache<LinkPreviewMetadata>({
    messageId,
    cacheKey: ['linkPreview', url],
    fetchFn: async () => {
      const preview = await fetchLinkPreview({ url })
      return {
        title: preview.title || url,
        description: preview.description || '',
        image: preview.image,
      }
    },
  })

  if (isLoading) {
    return <LinkPreviewSkeleton />
  }

  // Show error state with error message as description
  if (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to load preview'
    return <LinkPreview title={url} description={errorMessage} url={url} image={null} />
  }

  if (!data) {
    return <LinkPreview title={url} description="Failed to load preview" url={url} image={null} />
  }

  const imageUrl = data.image && cloudUrl.value ? `${cloudUrl.value}/pro/proxy/${encodeURIComponent(data.image)}` : null

  return <LinkPreview title={data.title} description={data.description} url={url} image={imageUrl} />
}

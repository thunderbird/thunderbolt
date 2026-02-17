import { Card, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useMessageCache } from '@/hooks/use-message-cache'
import { useSettings } from '@/hooks/use-settings'
import { fetchLinkPreview } from '@/integrations/thunderbolt-pro/api'
import type { SourceMetadata } from '@/types/source'
import { LinkPreview } from './display'

type LinkPreviewWidgetProps = {
  url: string
  source?: string
  sources?: SourceMetadata[]
  messageId: string
  fetchPreviewFn?: (params: { url: string }) => Promise<{
    title: string
    description: string
    image: string | null
  }>
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

/** Renders a link preview instantly from source registry metadata */
const InstantLinkPreview = ({ sourceData, cloudUrl }: { sourceData: SourceMetadata; cloudUrl: string | null }) => {
  const imageUrl = sourceData.image && cloudUrl ? `${cloudUrl}/pro/proxy/${encodeURIComponent(sourceData.image)}` : null

  return (
    <LinkPreview
      title={sourceData.title}
      description={sourceData.description ?? ''}
      url={sourceData.url}
      image={imageUrl}
    />
  )
}

export const LinkPreviewWidget = ({ url, source, sources, messageId, fetchPreviewFn }: LinkPreviewWidgetProps) => {
  const { cloudUrl } = useSettings({ cloud_url: 'http://localhost:8000/v1' })

  // Instant render path: resolve from source registry (O(1) index lookup)
  if (source && sources) {
    const sourceIndex = parseInt(source, 10)
    const sourceData = sources[sourceIndex - 1]
    if (sourceData && sourceData.title) {
      return <InstantLinkPreview sourceData={sourceData} cloudUrl={cloudUrl.value} />
    }
  }

  // Fallback: existing fetch-based path
  return <FetchLinkPreview url={url} messageId={messageId} cloudUrl={cloudUrl.value} fetchPreviewFn={fetchPreviewFn} />
}

/** Fallback component that fetches link preview data via the message cache */
const FetchLinkPreview = ({
  url,
  messageId,
  cloudUrl,
  fetchPreviewFn,
}: {
  url: string
  messageId: string
  cloudUrl: string | null
  fetchPreviewFn?: (params: { url: string }) => Promise<{
    title: string
    description: string
    image: string | null
  }>
}) => {
  const fetchFn = fetchPreviewFn ?? fetchLinkPreview
  const { data, isLoading, error } = useMessageCache<LinkPreviewMetadata>({
    messageId,
    cacheKey: ['linkPreview', url],
    fetchFn: async () => {
      const preview = await fetchFn({ url })
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

  if (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to load preview'
    return <LinkPreview title={url} description={errorMessage} url={url} image={null} />
  }

  if (!data) {
    return <LinkPreview title={url} description="Failed to load preview" url={url} image={null} />
  }

  const imageUrl = data.image && cloudUrl ? `${cloudUrl}/pro/proxy/${encodeURIComponent(data.image)}` : null

  return <LinkPreview title={data.title} description={data.description} url={url} image={imageUrl} />
}

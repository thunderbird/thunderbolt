import { Card, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useHttpClient } from '@/contexts'
import { useMessageCache } from '@/hooks/use-message-cache'
import { useSettings } from '@/hooks/use-settings'
import { fetchLinkPreview } from '@/integrations/thunderbolt-pro/api'
import type { SourceMetadata } from '@/types/source'
import { LinkPreview } from './display'
import { getHostname } from './utils'

type LinkPreviewWidgetProps = {
  url: string
  source?: string
  sources?: SourceMetadata[]
  messageId: string
  fetchPreviewFn?: (params: { url: string }) => Promise<{
    title: string | null
    description: string | null
    image: string | null
    siteName?: string | null
  }>
}

type LinkPreviewMetadata = {
  title: string | null
  description: string | null
  image: string | null
  siteName: string | null
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

/** Builds a proxied image URL via /proxy-image (when direct image URL is known) */
const buildProxyImageUrl = (imageUrl: string | null | undefined, cloudUrl: string | null): string | null => {
  if (!imageUrl || !cloudUrl?.trim()) {
    return null
  }
  return `${cloudUrl}/pro/link-preview/proxy-image/${encodeURIComponent(imageUrl)}`
}

/** Builds an image URL via /image (extracts og:image from page and proxies it in one request) */
const buildPageImageUrl = (pageUrl: string, cloudUrl: string | null): string | null => {
  if (!pageUrl || !cloudUrl?.trim()) {
    return null
  }
  return `${cloudUrl}/pro/link-preview/image/${encodeURIComponent(pageUrl)}`
}

/** Renders a link preview instantly from source registry metadata */
const InstantLinkPreview = ({ sourceData, cloudUrl }: { sourceData: SourceMetadata; cloudUrl: string | null }) => {
  return (
    <LinkPreview
      title={sourceData.title || getHostname(sourceData.url)}
      description={sourceData.description ?? null}
      url={sourceData.url}
      image={buildProxyImageUrl(sourceData.image, cloudUrl)}
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
    title: string | null
    description: string | null
    image: string | null
    siteName?: string | null
  }>
}) => {
  const httpClient = useHttpClient()
  const { data, isLoading, error } = useMessageCache<LinkPreviewMetadata>({
    messageId,
    cacheKey: ['linkPreview', url],
    fetchFn: async () => {
      const preview = fetchPreviewFn ? await fetchPreviewFn({ url }) : await fetchLinkPreview({ url }, httpClient)
      return {
        title: preview.title,
        description: preview.description,
        image: preview.image,
        siteName: preview.siteName ?? null,
      }
    },
  })

  // Prefer proxying the known image URL; fall back to /image/ which extracts og:image from the page
  const imageUrl = data?.image ? buildProxyImageUrl(data.image, cloudUrl) : buildPageImageUrl(url, cloudUrl)

  if (isLoading) {
    return <LinkPreviewSkeleton />
  }

  if (error || !data) {
    if (error) {
      console.warn('Link preview failed:', url)
    }
    return <LinkPreview title={getHostname(url)} description={null} url={url} image={null} />
  }

  const isEmpty = !data.title && !data.description && !data.image && !data.siteName
  if (isEmpty) {
    return <LinkPreview title={getHostname(url)} description={null} url={url} image={null} />
  }

  const displayTitle = data.title || data.siteName || getHostname(url)

  return <LinkPreview title={displayTitle} description={data.description} url={url} image={imageUrl} />
}

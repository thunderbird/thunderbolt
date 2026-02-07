import { Card, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useMessageCache } from '@/hooks/use-message-cache'
import { useSettings } from '@/hooks/use-settings'
import { fetchLinkPreview } from '@/integrations/thunderbolt-pro/api'
import { ImageIcon } from 'lucide-react'
import { useState } from 'react'
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
  const [imageError, setImageError] = useState(false)

  // Fetch metadata and image in parallel using separate queries
  // The image URL is constructed immediately so the <img> tag can start fetching in parallel
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

  // Construct image URL immediately (before early returns) so we can render <img> tag
  // This allows the image request to start in parallel with the metadata request
  // The image endpoint fetches the page, extracts image URL, fetches image, and returns it
  const imageUrl =
    cloudUrl.value && cloudUrl.value.trim()
      ? `${cloudUrl.value}/pro/link-preview/image/${encodeURIComponent(url)}`
      : null

  const placeholder = (
    <div className="h-full w-full bg-secondary/60 dark:bg-secondary/40 flex items-center justify-center">
      <ImageIcon className="h-8 w-8 text-secondary-foreground/20" />
    </div>
  )

  // Render image immediately (even while metadata loads) to enable parallel requests
  // The <img> tag will start fetching as soon as it renders, in parallel with metadata fetch
  if (isLoading) {
    // Show skeleton for text content, but render image immediately for parallel loading
    return (
      <div className="my-4">
        <Card className="flex-row flex p-0 gap-0 rounded-lg overflow-hidden">
          <div className="h-24 w-24 flex-shrink-0 grid">
            {imageUrl ? (
              imageError ? (
                placeholder
              ) : (
                <>
                  <div className="col-start-1 row-start-1">{placeholder}</div>
                  <img
                    src={imageUrl}
                    alt=""
                    className="col-start-1 row-start-1 h-full w-full object-cover opacity-0 transition-opacity"
                    onLoad={(e) => {
                      e.currentTarget.style.opacity = '1'
                    }}
                    onError={() => setImageError(true)}
                  />
                </>
              )
            ) : (
              <Skeleton className="h-24 w-24 rounded-none" />
            )}
          </div>
          <CardHeader className="flex-1 flex flex-col pl-4 py-4">
            <Skeleton className="h-5 w-3/4 mb-2" />
            <Skeleton className="h-2 w-full" />
          </CardHeader>
        </Card>
      </div>
    )
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

  // imageUrl is already constructed above (before early returns) to enable parallel fetching
  return <LinkPreview title={displayTitle} description={data.description} url={url} image={imageUrl} />
}

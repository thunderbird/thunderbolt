import { useMessageCache } from '@/hooks/use-message-cache'
import { useSettings } from '@/hooks/use-settings'
import { fetchLinkPreview } from '@/integrations/thunderbolt-pro/api'
import { ImageIcon } from 'lucide-react'
import { useState } from 'react'
import { Card, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Skeleton } from '../ui/skeleton'

type LinkPreviewProps = {
  url: string
  title: string | null
  description: string | null
  image: string | null
}

type LinkPreviewVisualProps = {
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

export const LinkPreviewVisual = ({ url, messageId }: LinkPreviewVisualProps) => {
  const { cloudUrl } = useSettings({ cloud_url: String })

  // Use message cache hook - it handles checking cache and fetching if needed
  const { data, isLoading } = useMessageCache<LinkPreviewMetadata>({
    messageId,
    cacheKey: `linkPreviews.${url}`,
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

  if (!data) {
    return null
  }

  const imageUrl = data.image && cloudUrl.value ? `${cloudUrl.value}/pro/proxy/${encodeURIComponent(data.image)}` : null

  return <LinkPreview title={data.title} description={data.description} url={url} image={imageUrl} />
}

export const LinkPreview = ({ description, image, title, url }: LinkPreviewProps) => {
  const [imageError, setImageError] = useState(false)
  const [isImageLoading, setIsImageLoading] = useState(!!image)
  const showPlaceholder = !image || imageError

  const placeholder = (
    <div className="h-full w-full bg-secondary/60 dark:bg-secondary/40 flex items-center justify-center">
      <ImageIcon className="h-8 w-8 text-secondary-foreground/20" />
    </div>
  )

  return (
    <div className="my-4">
      <a href={url} target="_blank" rel="noopener noreferrer">
        <Card className="cursor-pointer flex-row flex p-0 gap-0 rounded-lg overflow-hidden relative group">
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 dark:group-hover:bg-white/5 pointer-events-none z-10" />
          <div className="h-24 w-24 flex-shrink-0 relative">
            {showPlaceholder ? (
              placeholder
            ) : (
              <>
                {isImageLoading && <div className="absolute inset-0">{placeholder}</div>}
                <img
                  src={image}
                  alt={title ?? description ?? url}
                  className="h-full w-full object-cover"
                  onLoad={() => setIsImageLoading(false)}
                  onError={() => setImageError(true)}
                />
              </>
            )}
          </div>
          <CardHeader className="flex-1 flex flex-col pl-4 py-4">
            <CardTitle className="line-clamp-1">{title}</CardTitle>
            {description && <CardDescription className="line-clamp-2">{description}</CardDescription>}
          </CardHeader>
        </Card>
      </a>
    </div>
  )
}

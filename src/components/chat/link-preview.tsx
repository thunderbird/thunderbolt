import { useSettings } from '@/hooks/use-settings'
import { fetchContent } from '@/integrations/thunderbolt-pro/api'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
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
}

const useFetchLinkPreviewContent = (url: string) => {
  const { data, isLoading } = useQuery({
    queryKey: ['link-preview', url],
    queryFn: async () => {
      const content = await fetchContent({ url })
      return {
        description: content?.summary ?? '',
        image: content?.image ?? '',
        title: content?.title ?? '',
        url,
      }
    },
    enabled: !!url,
    retry: false,
    staleTime: 1000 * 60 * 60, // 1 hour - link previews are static
  })

  return { isLoading, content: data }
}

export const LinkPreviewSkeleton = () => {
  return (
    <motion.div
      className="my-4"
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{
        scale: 1,
        opacity: 1,
      }}
      exit={{
        opacity: 0,
      }}
    >
      <Card className="flex-row py-0 flex p-1 pr-2 gap-0">
        <Skeleton className="rounded-lg h-20 w-20" />
        <CardHeader className="flex-1 flex flex-col pl-4 my-2">
          <Skeleton className="h-5 w-3/4 mb-2" />
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-2 w-2/3 mt-1" />
        </CardHeader>
      </Card>
    </motion.div>
  )
}

export const LinkPreviewVisual = ({ url }: LinkPreviewVisualProps) => {
  const { content, isLoading } = useFetchLinkPreviewContent(url)
  const { cloudUrl } = useSettings({ cloud_url: String })

  if (isLoading) {
    return <LinkPreviewSkeleton />
  }

  if (!content) {
    return null
  }

  const imageUrl = content?.image && cloudUrl.value ? `${cloudUrl.value}/pro/proxy/${content?.image}` : null

  return <LinkPreview {...content} image={imageUrl} />
}

export const LinkPreview = ({ description, image, title, url }: LinkPreviewProps) => {
  const [imageError, setImageError] = useState(false)

  return (
    <motion.div
      className="my-4"
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{
        scale: 1,
        opacity: 1,
      }}
    >
      <a href={url} target="_blank" rel="noopener noreferrer">
        <Card className="cursor-pointer flex-row flex p-0 hover:bg-border gap-0 rounded-lg overflow-hidden">
          {!!image && !imageError && (
            <img
              src={image}
              alt={title ?? description ?? url}
              className="h-20 w-20 object-cover"
              onError={() => setImageError(true)}
            />
          )}
          <CardHeader className="flex-1 flex flex-col pl-4 py-4">
            <CardTitle className="line-clamp-1">{title}</CardTitle>
            {!!description && <CardDescription className="line-clamp-2">{description}</CardDescription>}
          </CardHeader>
        </Card>
      </a>
    </motion.div>
  )
}

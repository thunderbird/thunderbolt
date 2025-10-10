import { Card, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Skeleton } from '../ui/skeleton'
import { useCloudUrl } from '@/hooks/use-cloud-url'
import { fetchContent } from '@/integrations/thunderbolt-pro/tools'
import { markdownToText } from '@/lib/utils'
import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'

type LinkPreviewProps = {
  url: string
  title: string | null
  description: string | null
  image: string | null
}

type LinkPreviewContainerProps = {
  url: string
}

const useFetchLinkPreviewContent = (url: string) => {
  const [linkPreview, setLinkPreview] = useState<LinkPreviewProps>()
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (url) {
      fetchContent({ url })
        .then((content) =>
          setLinkPreview({
            description: markdownToText(content?.text ?? ''),
            image: content?.image ?? '',
            title: content?.title ?? '',
            url,
          }),
        )
        .finally(() => setIsLoading(false))
    }
  }, [url])

  return { isLoading, content: linkPreview }
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

export const LinkPreviewContainer = ({ url }: LinkPreviewContainerProps) => {
  const { content, isLoading } = useFetchLinkPreviewContent(url)
  const cloudUrl = useCloudUrl()

  if (isLoading) {
    return <LinkPreviewSkeleton />
  }

  if (!content) {
    return null
  }

  return <LinkPreview {...content} image={content?.image ? `${cloudUrl}/pro/proxy/${content?.image}` : null} />
}

export const LinkPreview = ({ description, image, title, url }: LinkPreviewProps) => {
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
        <Card className="cursor-pointer flex-row py-0 flex p-1 pr-2 hover:bg-border gap-0">
          {!!image && (
            <img src={image} alt={title ?? description ?? url} className="rounded-lg h-20 w-20 object-cover" />
          )}
          <CardHeader className="flex-1 flex flex-col pl-4 my-2">
            <CardTitle className="line-clamp-1">{title}</CardTitle>
            {!!description && <CardDescription className="line-clamp-2">{description}</CardDescription>}
          </CardHeader>
        </Card>
      </a>
    </motion.div>
  )
}

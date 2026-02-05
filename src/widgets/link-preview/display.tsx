import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { isDesktop as isTauriDesktop } from '@/lib/platform'
import { usePreview } from '@/content-view/context'
import { ExternalLink, ImageIcon } from 'lucide-react'
import { useState } from 'react'
import { getHostname } from './utils'

type LinkPreviewProps = {
  url: string
  title: string | null
  description: string | null
  image: string | null
}

export const LinkPreview = ({ description, image, title, url }: LinkPreviewProps) => {
  const [imageError, setImageError] = useState(false)
  const [isImageLoading, setIsImageLoading] = useState(!!image)
  const showPlaceholder = !image || imageError
  const { showPreview } = usePreview()
  const isDesktop = isTauriDesktop()

  const placeholder = (
    <div className="h-full w-full bg-secondary/60 dark:bg-secondary/40 flex items-center justify-center">
      <ImageIcon className="h-8 w-8 text-secondary-foreground/20" />
    </div>
  )

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (isDesktop) {
      e.preventDefault()
      e.stopPropagation()
      showPreview(url)
    }
    // If not desktop, let the default <a> behavior happen (open in browser)
  }

  return (
    <div className="my-4">
      <a
        href={isDesktop ? '#' : url}
        target={isDesktop ? undefined : '_blank'}
        rel={isDesktop ? undefined : 'noopener noreferrer'}
        onClick={handleClick}
      >
        <Card className="cursor-pointer flex-row flex p-0 gap-0 rounded-lg overflow-hidden relative group">
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 dark:group-hover:bg-white/5 pointer-events-none z-10" />
          <div className="h-24 w-24 flex-shrink-0 grid">
            {showPlaceholder ? (
              placeholder
            ) : (
              <>
                {isImageLoading && <div className="col-start-1 row-start-1">{placeholder}</div>}
                <img
                  src={image}
                  alt={title ?? description ?? url}
                  className={`col-start-1 row-start-1 h-full w-full object-cover transition-opacity ${isImageLoading ? 'opacity-0' : 'opacity-100'}`}
                  onLoad={() => setIsImageLoading(false)}
                  onError={() => setImageError(true)}
                />
              </>
            )}
          </div>
          <CardHeader className="flex-1 flex flex-col gap-1.5 pl-4 pt-4 pb-2">
            <CardTitle className="line-clamp-1">{title}</CardTitle>
            {description && <CardDescription className="line-clamp-2">{description}</CardDescription>}
            <span className="text-xs text-muted-foreground truncate">{getHostname(url)}</span>
          </CardHeader>
        </Card>
      </a>
    </div>
  )
}

type LinkChipProps = {
  url: string
}

export const LinkChip = ({ url }: LinkChipProps) => {
  const { showPreview } = usePreview()
  const isDesktop = isTauriDesktop()

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (isDesktop) {
      e.preventDefault()
      e.stopPropagation()
      showPreview(url)
    }
  }

  return (
    <div className="my-4">
      <a
        href={isDesktop ? '#' : url}
        target={isDesktop ? undefined : '_blank'}
        rel={isDesktop ? undefined : 'noopener noreferrer'}
        onClick={handleClick}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="truncate">{getHostname(url)}</span>
      </a>
    </div>
  )
}

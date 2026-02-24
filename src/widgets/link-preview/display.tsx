import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ExternalLinkDialog } from '@/components/chat/external-link-dialog'
import { useExternalLinkDialog } from '@/hooks/use-external-link-dialog'
import { isDesktop as isTauriDesktop } from '@/lib/platform'
import { isSafeUrl } from '@/lib/url-utils'
import { usePreview } from '@/content-view/context'
import { ImageIcon } from 'lucide-react'
import { useState } from 'react'

type LinkPreviewProps = {
  url: string
  title: string | null
  description: string | null
  image: string | null
}

/** Desktop: click opens in-app preview directly, no confirmation dialog. */
const LinkPreviewDesktop = ({ description, image, title, url }: LinkPreviewProps) => {
  const [imageError, setImageError] = useState(false)
  const [isImageLoading, setIsImageLoading] = useState(!!image)
  const { showPreview } = usePreview()
  const showPlaceholder = !image || imageError

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isSafeUrl(url)) return
    showPreview(url)
  }

  return (
    <div className="my-4">
      <a href="#" onClick={handleClick}>
        <LinkPreviewCard
          description={description}
          image={image}
          isImageLoading={isImageLoading}
          onImageError={() => setImageError(true)}
          onImageLoad={() => setIsImageLoading(false)}
          showPlaceholder={showPlaceholder}
          title={title}
          url={url}
        />
      </a>
    </div>
  )
}

/** Web: click shows confirmation dialog, then opens in new tab. */
const LinkPreviewWithDialog = ({ description, image, title, url }: LinkPreviewProps) => {
  const [imageError, setImageError] = useState(false)
  const [isImageLoading, setIsImageLoading] = useState(!!image)
  const { dialogOpen, pendingUrl, openDialog, handleConfirm, setDialogOpen } = useExternalLinkDialog()
  const showPlaceholder = !image || imageError

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isSafeUrl(url)) return
    openDialog(url)
  }

  return (
    <div className="my-4">
      <a href="#" onClick={handleClick}>
        <LinkPreviewCard
          description={description}
          image={image}
          isImageLoading={isImageLoading}
          onImageError={() => setImageError(true)}
          onImageLoad={() => setIsImageLoading(false)}
          showPlaceholder={showPlaceholder}
          title={title}
          url={url}
        />
      </a>
      <ExternalLinkDialog open={dialogOpen} onOpenChange={setDialogOpen} url={pendingUrl} onConfirm={handleConfirm} />
    </div>
  )
}

type LinkPreviewCardProps = Pick<LinkPreviewProps, 'description' | 'image' | 'title' | 'url'> & {
  showPlaceholder: boolean
  isImageLoading: boolean
  onImageError: () => void
  onImageLoad: () => void
}

const placeholder = (
  <div className="h-full w-full bg-secondary/60 dark:bg-secondary/40 flex items-center justify-center">
    <ImageIcon className="h-8 w-8 text-secondary-foreground/20" />
  </div>
)

const LinkPreviewCard = ({
  description,
  image,
  isImageLoading,
  onImageError,
  onImageLoad,
  showPlaceholder,
  title,
  url,
}: LinkPreviewCardProps) => (
  <Card className="cursor-pointer flex-row flex p-0 gap-0 rounded-lg overflow-hidden relative group">
    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 dark:group-hover:bg-white/5 pointer-events-none z-10" />
    <div className="h-24 w-24 flex-shrink-0 grid">
      {showPlaceholder ? (
        placeholder
      ) : (
        <>
          {isImageLoading && <div className="col-start-1 row-start-1">{placeholder}</div>}
          <img
            src={image ?? undefined}
            alt={title ?? description ?? url}
            className={`col-start-1 row-start-1 h-full w-full object-cover transition-opacity ${isImageLoading ? 'opacity-0' : 'opacity-100'}`}
            onLoad={onImageLoad}
            onError={() => {
              onImageError()
              onImageLoad()
            }}
          />
        </>
      )}
    </div>
    <CardHeader className="flex-1 flex flex-col pl-4 py-4">
      <CardTitle className="line-clamp-1">{title}</CardTitle>
      {description && <CardDescription className="line-clamp-2">{description}</CardDescription>}
    </CardHeader>
  </Card>
)

export const LinkPreview = (props: LinkPreviewProps) => {
  const isDesktop = isTauriDesktop()
  return isDesktop ? <LinkPreviewDesktop {...props} /> : <LinkPreviewWithDialog {...props} />
}

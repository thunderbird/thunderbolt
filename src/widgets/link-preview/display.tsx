/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useOpenExternalLink } from '@/components/chat/markdown-utils'
import { isSafeUrl } from '@/lib/url-utils'
import { publicWebMediaUrl } from '@/integrations/standalone-search/url-policy'
import { ImageIcon } from 'lucide-react'
import { type MouseEvent, useState } from 'react'

type LinkPreviewProps = {
  url: string
  title: string // Required: parent component must provide hostname fallback if backend returns null
  description: string | null
  image: string | null
}

const placeholder = (
  <div className="h-full w-full bg-secondary/60 dark:bg-secondary/40 flex items-center justify-center">
    <ImageIcon className="h-8 w-8 text-secondary-foreground/20" />
  </div>
)

const LinkPreviewCard = ({ description, image, title }: LinkPreviewProps) => (
  <Card className="cursor-pointer flex-row flex p-0 gap-0 rounded-xl overflow-hidden relative group">
    <div className="absolute inset-0 group-hover:bg-foreground/5 pointer-events-none z-10" />
    <div className="h-24 w-24 flex-shrink-0 grid">
      {image ? <LinkPreviewImage key={image} src={image} alt={title} /> : placeholder}
    </div>
    <CardHeader className="flex-1 flex flex-col pl-4 py-4">
      <CardTitle className="line-clamp-1">{title}</CardTitle>
      {description && <CardDescription className="line-clamp-2">{description}</CardDescription>}
    </CardHeader>
  </Card>
)

const LinkPreviewImage = ({ src, alt }: { src: string; alt: string }) => {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading')
  if (status === 'failed') {
    return placeholder
  }
  return (
    <>
      {status === 'loading' && <div className="col-start-1 row-start-1">{placeholder}</div>}
      <img
        src={src}
        referrerPolicy="no-referrer"
        alt={alt}
        className={`col-start-1 row-start-1 h-full w-full object-cover transition-opacity ${status === 'loading' ? 'opacity-0' : 'opacity-100'}`}
        onLoad={() => setStatus('loaded')}
        onError={() => setStatus('failed')}
      />
    </>
  )
}

export const LinkPreview = ({ description, image, title, url }: LinkPreviewProps) => {
  const openExternalLink = useOpenExternalLink()

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    e.stopPropagation()

    if (!isSafeUrl(url)) {
      return
    }

    openExternalLink(url)
  }

  return (
    <div className="my-4">
      <a href={isSafeUrl(url) ? url : '#'} target="_blank" rel="noopener noreferrer" onClick={handleClick}>
        <LinkPreviewCard description={description} image={publicWebMediaUrl(image)} title={title} url={url} />
      </a>
    </div>
  )
}

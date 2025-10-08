import { useEffect, useState } from 'react'
import { Card, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { type ToolUIPart } from 'ai'
import { type FetchContentData } from '@/integrations/thunderbolt-pro/tools'
import { useCloudUrl } from '@/hooks/use-cloud-url'
import { motion } from 'framer-motion'
import { markdownToText } from '@/lib/utils'

type LinkPreviewProps = {
  tools: ToolUIPart[]
}

type Link = {
  url: string
  title: string
  description: string
  image: string
}

const useLinkPreview = (tools: ToolUIPart[]) => {
  const [links, setLinks] = useState<Link[]>([])

  useEffect(() => {
    setLinks(
      tools
        .filter((tool) => tool.type === 'tool-fetch_content')
        .map((tool) => {
          const output = tool.output as FetchContentData
          return {
            title: output?.title ?? '',
            description: markdownToText(output?.text || ''),
            url: output?.url ?? '',
            image: output?.image ?? '',
          }
        }),
    )
  }, [tools])

  return { links }
}

export const LinkPreview = ({ tools }: LinkPreviewProps) => {
  const { links } = useLinkPreview(tools)
  const cloudUrl = useCloudUrl()

  if (!links.length) {
    return null
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {links.map((link) => {
        return (
          <motion.div
            initial={{ scale: 0 }}
            animate={{
              scale: 1,
            }}
          >
            <a href={link.url} target="_blank">
              <Card className="cursor-pointer flex-row py-0 flex gap-4 p-1 pr-2 hover:bg-border">
                {!!link.image && !!cloudUrl && (
                  <img
                    src={`${cloudUrl}/pro/proxy/${link.image}`}
                    alt={link.title}
                    className="rounded-lg h-20 w-20 object-cover"
                  />
                )}
                <CardHeader className="flex-1 flex flex-col pl-0 my-2">
                  <CardTitle className="line-clamp-1">{link.title}</CardTitle>
                  {!!link.description && <CardDescription className="line-clamp-2">{link.description}</CardDescription>}
                </CardHeader>
              </Card>
            </a>
          </motion.div>
        )
      })}
    </div>
  )
}

import { useSettings } from '@/hooks/use-settings'
import { getProxiedFaviconUrl } from '@/lib/url-utils'
import { cn } from '@/lib/utils'
import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { Avatar, AvatarFallback } from '../ui/avatar'

type ToolIconProps = {
  toolName: string
  toolOutput: unknown
  Icon: LucideIcon | null
  initials: string
  isLoading: boolean
  isError: boolean
  tooltipKey: string
  onClick: () => void
  className?: string
}

/**
 * Extracts favicon URL from tool output for search and fetch_content tools
 */
export const extractFaviconUrl = (toolName: string, output: unknown): string | null => {
  if (toolName !== 'fetch_content' && toolName !== 'search') return null

  const parsedOutput = typeof output === 'string' ? JSON.parse(output) : output

  if (Array.isArray(parsedOutput)) {
    return parsedOutput[0]?.favicon || null
  }

  return parsedOutput?.favicon || null
}

/**
 * Hook to manage favicon fetching and error handling for tool outputs
 */
const useToolFavicon = (toolName: string, toolOutput: unknown, isLoading: boolean, isError: boolean) => {
  const [failedFavicons, setFailedFavicons] = useState<Set<string>>(new Set())
  const { cloudUrl } = useSettings({ cloud_url: 'http://localhost:8000/v1' })

  const handleFaviconError = (url: string) => {
    setFailedFavicons((prev) => new Set(prev).add(url))
  }

  if (!toolOutput || isLoading || isError || !cloudUrl.value) {
    return { favicon: null, originalFaviconUrl: null, handleFaviconError }
  }

  try {
    const originalFaviconUrl = extractFaviconUrl(toolName, toolOutput)
    if (!originalFaviconUrl || failedFavicons.has(originalFaviconUrl)) {
      return { favicon: null, originalFaviconUrl, handleFaviconError }
    }

    const favicon = getProxiedFaviconUrl(originalFaviconUrl, cloudUrl.value)
    return { favicon, originalFaviconUrl, handleFaviconError }
  } catch {
    return { favicon: null, originalFaviconUrl: null, handleFaviconError }
  }
}

export const ToolIcon = ({
  toolName,
  toolOutput,
  Icon,
  initials,
  isLoading,
  isError,
  tooltipKey,
  onClick,
  className,
}: ToolIconProps) => {
  const { favicon, originalFaviconUrl, handleFaviconError } = useToolFavicon(toolName, toolOutput, isLoading, isError)

  return (
    <Avatar
      className={cn(
        'border-2 border-background size-9 overflow-hidden cursor-pointer',
        favicon && 'grayscale-0',
        isLoading && 'shimmer-container',
        className,
      )}
      onClick={onClick}
    >
      <AvatarFallback>
        {favicon ? (
          <motion.div
            key={`${tooltipKey}-favicon`}
            initial={{ scale: 0 }}
            animate={{
              scale: isLoading ? 0 : 1,
            }}
            exit={{ scale: 0 }}
          >
            <img
              src={favicon}
              alt=""
              className="size-4 object-cover rounded-full"
              onError={() => originalFaviconUrl && handleFaviconError(originalFaviconUrl)}
            />
          </motion.div>
        ) : Icon ? (
          <Icon className={cn('size-4', isError && 'text-yellow-500')} />
        ) : (
          initials
        )}
      </AvatarFallback>
    </Avatar>
  )
}

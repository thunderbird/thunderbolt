/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { usePrivateSources } from '@/components/chat/private-sources-context'
import { Card, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useHttpClient } from '@/contexts'
import { useMessageCache } from '@/hooks/use-message-cache'
import { fetchLinkPreview } from '@/integrations/thunderbolt-pro/api'
import { useServerAuthentication } from '@/hooks/use-local-providers'
import { useSettings } from '@/hooks/use-settings'
import { useQuery } from '@tanstack/react-query'
import { hasProAccess } from '@/integrations/thunderbolt-pro/utils'
import { resolveSearchSelection } from '@/integrations/standalone-search/selection'
import { useSearchProviderAvailability } from '@/integrations/standalone-search/use-search-provider-availability'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import type { LinkPreviewData } from '@/integrations/thunderbolt-pro/schemas'
import type { SourceMetadata } from '@/types/source'
import { LinkPreview } from './display'
import { getHostname } from './utils'

type LinkPreviewWidgetProps = {
  url: string
  source?: string
  sourceMetadata?: SourceMetadata[]
  messageId: string
  fetchPreviewFn?: (params: { url: string }) => Promise<LinkPreviewData>
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

/** Renders collected metadata while preserving the source's passive-image policy. */
const InstantLinkPreview = ({ sourceData }: { sourceData: SourceMetadata }) => {
  const privateSources = usePrivateSources([sourceData])
  return (
    <LinkPreview
      title={sourceData.title || getHostname(sourceData.url)}
      description={sourceData.description ?? null}
      url={sourceData.url}
      image={privateSources ? null : (sourceData.image ?? null)}
    />
  )
}

/** Matches the page identity without letting URL fragments bypass a saved privacy policy. */
const pageUrl = (value: string) => {
  if (!URL.canParse(value)) {
    return value
  }
  const url = new URL(value)
  url.hash = ''
  return url.href
}

export const LinkPreviewWidget = ({
  url,
  source,
  sourceMetadata,
  messageId,
  fetchPreviewFn,
}: LinkPreviewWidgetProps) => {
  const privateSources = usePrivateSources(sourceMetadata)
  const sourceData =
    sourceMetadata?.find(({ index }) => index === Number(source)) ??
    sourceMetadata?.find((entry) => pageUrl(entry.url) === pageUrl(url))
  if (sourceData) {
    return <InstantLinkPreview sourceData={sourceData} />
  }
  // A model can omit or invent a source reference. Such markup cannot authorize a
  // fresh cloud request when the message's evidence was gathered privately.
  if (privateSources) {
    return <LinkPreview title={getHostname(url)} description={null} url={url} image={null} />
  }
  if (fetchPreviewFn) {
    return <FetchLinkPreview url={url} messageId={messageId} fetchPreviewFn={fetchPreviewFn} />
  }
  return <ProviderLinkPreview url={url} messageId={messageId} />
}

/** Passive previews follow the same provider choice as web tools and never silently use a different server. */
const ProviderLinkPreview = ({ url, messageId }: Pick<LinkPreviewWidgetProps, 'url' | 'messageId'>) => {
  const authenticated = useServerAuthentication()
  const { integrationsProIsEnabled } = useSettings({ integrations_pro_is_enabled: false })
  const { data: proAccess } = useQuery({ queryKey: ['pro-access'], queryFn: hasProAccess })
  const selection = useSearchProviderStore((state) => state.selection)
  const { custom, tinfoil, tinfoilConfigured, ready } = useSearchProviderAvailability()
  const useCloudPreview =
    ready &&
    resolveSearchSelection(selection, {
      custom,
      tinfoil,
      tinfoilConfigured,
      cloud: authenticated && Boolean(proAccess) && integrationsProIsEnabled.value,
    }) === 'cloud'
  if (!useCloudPreview) {
    return <LinkPreview title={getHostname(url)} description={null} url={url} image={null} />
  }
  return <FetchLinkPreview url={url} messageId={messageId} />
}

/** Fallback component that fetches link preview data via the message cache */
const FetchLinkPreview = ({
  url,
  messageId,
  fetchPreviewFn,
}: {
  url: string
  messageId: string
  fetchPreviewFn?: (params: { url: string }) => Promise<LinkPreviewData>
}) => {
  const httpClient = useHttpClient()
  const { data, isLoading, error } = useMessageCache<LinkPreviewData>({
    messageId,
    cacheKey: ['linkPreview', url],
    fetchFn: () => {
      if (fetchPreviewFn) {
        return fetchPreviewFn({ url })
      }
      return fetchLinkPreview({ url }, httpClient)
    },
  })

  if (isLoading) {
    return <LinkPreviewSkeleton />
  }

  if (error || !data) {
    if (error) {
      console.warn('Link preview failed:', url)
    }
    return <LinkPreview title={getHostname(url)} description={null} url={url} image={null} />
  }

  const isEmpty = !data.title && !data.summary && !data.previewImageUrl && !data.siteName
  if (isEmpty) {
    return <LinkPreview title={getHostname(url)} description={null} url={url} image={null} />
  }

  const displayTitle = data.title || data.siteName || getHostname(url)

  return <LinkPreview title={displayTitle} description={data.summary} url={url} image={data.previewImageUrl} />
}

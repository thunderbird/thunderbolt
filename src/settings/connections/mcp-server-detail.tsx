/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Check, Copy, LockKeyhole, RefreshCw } from 'lucide-react'

import { DetailDivider, DetailPanel, DetailSectionTitle } from '@/components/detail-panel'
import { AvailableTools } from '@/components/available-tools'
import { DetailActionsMenu, DetailEditDeleteMenuItems } from '@/components/settings/detail-actions-menu'
import { StatusIndicator, type StatusState } from '@/components/status-indicator'
import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import type { OAuthCardState } from '@/hooks/use-mcp-server-oauth'
import type { McpServer } from '@/types'
import { cleanServerUrl, serverDisplayName } from './display'

const statusLabels: Record<string, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  error: 'Connection error',
}

const transportLabels: Record<string, string> = {
  http: 'HTTP',
  sse: 'SSE',
  iroh: 'iroh (peer-to-peer)',
  stdio: 'stdio',
}

/**
 * Slide-in detail panel for one MCP server: live status with the retry /
 * authorize affordances, the endpoint, and the connected server's tool list.
 * Edit and Delete live in the ⋯ menu (same idiom as skills/agents).
 */
export const McpServerDetail = ({
  server,
  status,
  connectionError,
  actionError,
  oauthState,
  tools,
  isRetrying,
  onRetry,
  onAuthorize,
  onEdit,
  onDelete,
  onClose,
}: {
  server: McpServer
  status: StatusState
  /** A genuine connection failure (enabled, not connected, non-OAuth). */
  connectionError: Error | null
  /** A failed user action on this server (e.g. a retry that threw). */
  actionError: string | null
  oauthState: OAuthCardState | { phase: 'authorized' } | null
  tools: string[]
  isRetrying: boolean
  onRetry: () => void
  onAuthorize: () => void
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
}) => {
  const { copy, isCopied } = useCopyToClipboard()

  const handleCopyUrl = async () => {
    try {
      await copy(server.url ?? '')
    } catch (error) {
      console.error('Failed to copy URL:', error)
    }
  }

  const isEnabled = server.enabled === 1
  const isAuthorizing = oauthState?.phase === 'authorizing'
  const showAuthorize = oauthState?.phase === 'needs-auth' || oauthState?.phase === 'error'
  const isAuthorized = oauthState?.phase === 'authorized'
  const effectiveStatus: StatusState = !isEnabled ? 'neutral' : connectionError ? 'error' : status

  const actionsMenu = (
    <DetailActionsMenu>
      <DetailEditDeleteMenuItems onEdit={onEdit} onDelete={onDelete} />
    </DetailActionsMenu>
  )

  return (
    <DetailPanel
      title={serverDisplayName(server)}
      subtitle={cleanServerUrl(server.url ?? '')}
      actions={actionsMenu}
      onClose={onClose}
    >
      <div className="flex shrink-0 flex-col gap-2">
        <DetailSectionTitle>Status</DetailSectionTitle>
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2 text-base text-foreground">
            <StatusIndicator status={effectiveStatus} size="sm" />
            {isEnabled ? statusLabels[connectionError ? 'error' : status] : 'Disabled'}
          </span>
          <span className="flex items-center gap-2">
            {connectionError && (
              <Button variant="outline" size="sm" disabled={isRetrying} onClick={onRetry}>
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isRetrying ? 'animate-spin' : ''}`} />
                {isRetrying ? 'Retrying…' : 'Retry connection'}
              </Button>
            )}
            {(showAuthorize || isAuthorizing) && (
              <Button variant="outline" size="sm" disabled={isAuthorizing} onClick={onAuthorize}>
                <LockKeyhole className="h-3.5 w-3.5 mr-1.5" />
                {isAuthorizing ? 'Authorizing…' : 'Authorize'}
              </Button>
            )}
            {isAuthorized && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={onAuthorize}>
                    <Check className="h-3.5 w-3.5 mr-1.5 text-success" />
                    Re-authorize
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>Authorized. Re-run the OAuth flow if access was revoked.</p>
                </TooltipContent>
              </Tooltip>
            )}
          </span>
        </div>
        {connectionError && (
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="text-sm text-destructive cursor-default">
                Could not connect to this server. Check the URL and that the server is reachable.
              </p>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="max-w-xs break-words">{connectionError.message}</p>
            </TooltipContent>
          </Tooltip>
        )}
        {actionError && <p className="text-sm text-destructive">{actionError}</p>}
        {oauthState?.phase === 'needs-auth' && (
          <p className="text-sm text-muted-foreground">
            {oauthState.message ?? 'This server requires authorization. Click Authorize to connect.'}
          </p>
        )}
        {oauthState?.phase === 'error' && <p className="text-sm text-destructive">{oauthState.message}</p>}
      </div>

      <DetailDivider />

      <div className="flex shrink-0 flex-col gap-2">
        <DetailSectionTitle>{server.type === 'iroh' ? 'Bridge target' : 'Server URL'}</DetailSectionTitle>
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 break-all font-mono text-sm text-foreground">{server.url}</p>
          <Button
            variant="ghost"
            size="icon"
            aria-label={server.type === 'iroh' ? 'Copy bridge target' : 'Copy URL'}
            className={mutedIconButtonClass}
            onClick={handleCopyUrl}
            disabled={isCopied}
          >
            {isCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
          Transport: {transportLabels[server.type ?? 'http'] ?? server.type}
        </p>
      </div>

      {isEnabled && tools.length > 0 && (
        <>
          <DetailDivider />
          <AvailableTools tools={tools.map((tool) => ({ name: tool, enabled: true }))} />
        </>
      )}
    </DetailPanel>
  )
}

import { AvailableTools } from '@/components/available-tools'
import { StatusIndicator } from '@/components/status-indicator'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { McpTransportType, McpAuthType } from '@/types/mcp'
import type { McpServer } from '@/types'
import { Check, Copy, Globe, Key, RefreshCw, Terminal, Trash2 } from 'lucide-react'

const transportLabel: Record<McpTransportType, string> = {
  http: 'HTTP',
  sse: 'SSE',
  stdio: 'stdio',
}

const TransportBadge = ({ type }: { type: McpTransportType }) => (
  <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
    {transportLabel[type]}
  </span>
)

const AuthBadge = ({ authType }: { authType: McpAuthType }) => {
  if (authType === 'none') {
    return null
  }
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
      <Key className="h-3 w-3" />
      {authType === 'bearer' ? 'Key' : 'OAuth'}
    </span>
  )
}

type McpServerCardProps = {
  server: McpServer
  status: string
  tools: string[]
  selectedTools: { [tool: string]: boolean }
  errorMessage: string | null
  copiedUrl: string | null
  deleteConfirmOpen: string | null
  onToggle: (id: string, enabled: boolean) => void
  onDelete: (id: string) => void
  onCopyUrl: (url: string) => void
  onDeleteConfirmChange: (id: string | null) => void
  onRetry: (id: string) => void
  onAuthorize: (id: string) => void
  getStatusTooltipText: (status: string) => string
  formatServerTitle: (url: string) => string
}

export const McpServerCard = ({
  server,
  status,
  tools,
  selectedTools,
  errorMessage,
  copiedUrl,
  deleteConfirmOpen,
  onToggle,
  onDelete,
  onCopyUrl,
  onDeleteConfirmChange,
  onRetry,
  onAuthorize,
  getStatusTooltipText,
  formatServerTitle,
}: McpServerCardProps) => {
  const isEnabled = server.enabled === 1
  const serverTransport = (server.type ?? 'http') as McpTransportType
  const serverAuthType = (server.authType ?? 'none') as McpAuthType

  return (
    <Card className="border border-border shadow-sm">
      <CardHeader className="py-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <StatusIndicator
                    status={status === 'error' ? 'offline' : (status as 'connected' | 'connecting' | 'disconnected')}
                    size="md"
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{getStatusTooltipText(status)}</p>
              </TooltipContent>
            </Tooltip>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Popover>
                  <PopoverTrigger asChild>
                    <CardTitle className="text-lg font-medium cursor-pointer truncate">
                      {formatServerTitle(server.url ?? server.command ?? '')}
                    </CardTitle>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-2" side="bottom" align="start">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-mono">{server.url ?? server.command}</p>
                      {server.url && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 hover:bg-muted"
                          onClick={(e) => {
                            e.stopPropagation()
                            onCopyUrl(server.url ?? '')
                          }}
                          disabled={copiedUrl === server.url}
                        >
                          {copiedUrl === server.url ? (
                            <Check className="h-3 w-3 text-muted-foreground" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </Button>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      {serverTransport === 'stdio' ? (
                        <Terminal className="h-4 w-4 text-muted-foreground cursor-default" />
                      ) : (
                        <Globe className="h-4 w-4 text-muted-foreground cursor-default" />
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p>{serverTransport === 'stdio' ? 'Local (stdio)' : 'Remote'}</p>
                  </TooltipContent>
                </Tooltip>
                <TransportBadge type={serverTransport} />
                <AuthBadge authType={serverAuthType} />
              </div>
              {errorMessage === 'needsAuth' && (
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-xs text-amber-600">Authorization required</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-5 px-2 text-xs"
                    onClick={() => onAuthorize(server.id)}
                  >
                    Authorize
                  </Button>
                </div>
              )}
              {errorMessage && errorMessage !== 'needsAuth' && (
                <p className="text-xs text-muted-foreground mt-0.5">{errorMessage}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            {status === 'error' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => onRetry(server.id)}>
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>Retry connection</p>
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Switch
                    checked={isEnabled}
                    onCheckedChange={(checked) => onToggle(server.id, checked)}
                    className="cursor-pointer"
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{isEnabled ? 'Disable server' : 'Enable server'}</p>
              </TooltipContent>
            </Tooltip>
            <Popover
              open={deleteConfirmOpen === server.id}
              onOpenChange={(open) => onDeleteConfirmChange(open ? server.id : null)}
            >
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80" side="bottom" align="end">
                <div className="space-y-3">
                  <div>
                    <h4 className="font-medium">Remove Server</h4>
                    <p className="text-sm text-muted-foreground">
                      Are you sure you want to remove this MCP server? This action cannot be undone.
                    </p>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => onDeleteConfirmChange(null)}>
                      Cancel
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => onDelete(server.id)}>
                      Remove
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </CardHeader>
      {isEnabled && tools.length > 0 && (
        <CardContent className="pt-0 border-t">
          <AvailableTools
            className="pt-4"
            tools={tools.map((tool) => ({
              name: tool,
              enabled: selectedTools[tool] ?? true,
            }))}
          />
        </CardContent>
      )}
    </Card>
  )
}

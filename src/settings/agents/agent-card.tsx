import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AlertTriangle, ArrowUpCircle, Download, Globe, Loader2, Terminal, Trash2, Zap } from 'lucide-react'
import { useState } from 'react'
import { getDistributionLabel, isLocalDistribution, type MergedAgent } from './use-agent-registry'

type AgentCardProps = {
  agent: MergedAgent
  proxyBase: string
  isInstalling: boolean
  isUninstalling: boolean
  error?: string
  /** When true, local agent install buttons are disabled with a tooltip */
  desktopOnly?: boolean
  /** When true, CLI agent install buttons are disabled pending preview feature enablement */
  cliInstallBlocked?: boolean
  onInstall: (agent: MergedAgent) => void
  onUninstall: (agent: MergedAgent) => void
  onToggle: (agent: MergedAgent, enabled: boolean) => void
}

const FallbackIcon = ({ agent }: { agent: MergedAgent }) => {
  const Icon = agent.isBuiltIn ? Zap : agent.isRemote ? Globe : Terminal
  return (
    <div className="flex items-center justify-center bg-muted text-muted-foreground size-8 rounded-md font-medium flex-shrink-0">
      <Icon className="size-4" />
    </div>
  )
}

export const AgentCard = ({
  agent,
  proxyBase,
  isInstalling,
  isUninstalling,
  error,
  desktopOnly,
  cliInstallBlocked,
  onInstall,
  onUninstall,
  onToggle,
}: AgentCardProps) => {
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [iconError, setIconError] = useState(false)
  const isBusy = isInstalling || isUninstalling
  const distLabel = getDistributionLabel(agent.distributionType)
  const canUninstall = !agent.isBuiltIn && (!agent.isRemote || agent.isCustom)

  const proxiedIcon = agent.icon && proxyBase ? `${proxyBase}/pro/proxy/${encodeURIComponent(agent.icon)}` : null
  const showIcon = proxiedIcon && !iconError

  return (
    <Card className="border border-border py-0 gap-0">
      <div className="px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {showIcon ? (
              <img
                src={proxiedIcon}
                alt=""
                className="size-8 rounded-md flex-shrink-0 dark:invert"
                onError={() => setIconError(true)}
              />
            ) : (
              <FallbackIcon agent={agent} />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm truncate">{agent.name}</span>
                {agent.installedVersion && (
                  <span className="text-xs text-muted-foreground">v{agent.installedVersion}</span>
                )}
                {!agent.isInstalled && agent.version && (
                  <span className="text-xs text-muted-foreground">v{agent.version}</span>
                )}
                {distLabel && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{distLabel}</span>
                )}
                {agent.updateAvailable && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <ArrowUpCircle className="size-4 text-blue-500" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Update available: v{agent.version}</p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              {agent.description && (
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{agent.description}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-shrink-0">
            {agent.isInstalled ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <Switch
                        checked={agent.enabled}
                        onCheckedChange={(checked) => onToggle(agent, checked)}
                        disabled={isBusy}
                        className="cursor-pointer"
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{agent.enabled ? 'Disable agent' : 'Enable agent'}</p>
                  </TooltipContent>
                </Tooltip>

                {canUninstall && (
                  <Popover open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" disabled={isBusy}>
                        {isUninstalling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-80" side="bottom" align="end">
                      <div className="space-y-3">
                        <div>
                          <h4 className="font-medium">{agent.isCustom ? 'Remove Agent' : 'Uninstall Agent'}</h4>
                          <p className="text-sm text-muted-foreground">
                            {agent.isCustom
                              ? `Remove "${agent.name}" from your agents list?`
                              : `Uninstall "${agent.name}"? This will remove the agent from disk.`}
                          </p>
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => setDeleteConfirmOpen(false)}>
                            Cancel
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => {
                              setDeleteConfirmOpen(false)
                              onUninstall(agent)
                            }}
                          >
                            {agent.isCustom ? 'Remove' : 'Uninstall'}
                          </Button>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                )}
              </>
            ) : desktopOnly && isLocalDistribution(agent.distributionType) ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button variant="outline" size="sm" disabled>
                      <Download className="h-4 w-4 mr-1" />
                      Install
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Requires the Thunderbolt desktop app</p>
                </TooltipContent>
              </Tooltip>
            ) : cliInstallBlocked && isLocalDistribution(agent.distributionType) ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button variant="outline" size="sm" disabled>
                      <Download className="h-4 w-4 mr-1" />
                      Install
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Enable in Preferences → Preview Features</p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <Button variant="outline" size="sm" onClick={() => onInstall(agent)} disabled={isBusy}>
                {isInstalling ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Download className="h-4 w-4 mr-1" />
                )}
                Install
              </Button>
            )}
          </div>
        </div>
      </div>
      {error && (
        <div className="flex items-start gap-2 px-5 pb-4 -mt-1">
          <AlertTriangle className="size-3.5 text-destructive flex-shrink-0 mt-0.5" />
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}
    </Card>
  )
}

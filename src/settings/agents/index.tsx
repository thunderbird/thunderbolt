import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogTrigger } from '@/components/ui/dialog'
import { PageHeader } from '@/components/ui/page-header'
import { PageSearch } from '@/components/ui/page-search'
import { addCustomAgent, addRemoteAgent, installRegistryAgent, toggleAgent, uninstallRegistryAgent } from '@/dal/agents'
import { useDatabase } from '@/contexts'
import { agentsTable } from '@/db/tables'
import type { Agent } from '@/types'
import ky from 'ky'
import { getAuthToken } from '@/lib/auth-token'
import { useQuery } from '@powersync/tanstack-react-query'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { isNotNull, isNull, and, or, eq } from 'drizzle-orm'
import { useSettings } from '@/hooks/use-settings'
import { isAgentAvailableOnPlatform } from '@/lib/platform'
import { Bot, Plus, Terminal } from 'lucide-react'
import { useCallback, useState, type ReactNode } from 'react'
import { useQuery as useTanstackQuery, useQueryClient } from '@tanstack/react-query'
import { AgentCard } from './agent-card'
import { AddCustomAgentDialogContent, type AddAgentParams } from './add-custom-agent-dialog'
import { InstallWarningDialogContent } from './install-warning-dialog'
import {
  mergeRegistryWithInstalled,
  filterAgents,
  sortAgents,
  groupAgentsBySection,
  type MergedAgent,
} from './use-agent-registry'
import { parseRegistryJson, getRegistryPlatformKey, getPreferredDistribution } from '@/acp/registry'
import {
  installNpxAgent,
  installBinaryAgent,
  installUvxAgent,
  uninstallAgent as uninstallAgentFromDisk,
} from '@/acp/agent-installer'

const AgentSection = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="grid gap-3">
    <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{title}</h3>
    {children}
  </div>
)

export default function AgentsSettingsPage() {
  const db = useDatabase()
  const queryClient = useQueryClient()
  const { cloudUrl, experimentalFeatureAgentsCli } = useSettings({
    cloud_url: 'http://localhost:8000/v1',
    experimental_feature_agents_cli: false,
  })
  const [searchQuery, setSearchQuery] = useState('')
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [busyAgents, setBusyAgents] = useState<Map<string, 'installing' | 'uninstalling'>>(new Map())
  const [agentErrors, setAgentErrors] = useState<Map<string, string>>(new Map())
  const [pendingInstallAgent, setPendingInstallAgent] = useState<MergedAgent | null>(null)

  const canInstallLocal = isAgentAvailableOnPlatform('local')

  // Fetch unified agent list from backend (ACP registry + remote agents merged server-side)
  const { data: registryData } = useTanstackQuery({
    queryKey: ['agent-registry', cloudUrl.value],
    queryFn: async () => {
      const token = getAuthToken()
      const json = await ky
        .get(`${cloudUrl.value}/agents`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: 'include',
        })
        .json<{ agents?: unknown[]; allowCustomAgents?: boolean }>()
      return {
        entries: Array.isArray(json?.agents) ? parseRegistryJson(JSON.stringify(json)) : [],
        allowCustomAgents: json?.allowCustomAgents ?? true,
      }
    },
    staleTime: 60_000,
    enabled: !!cloudUrl.value,
  })

  const registryEntries = registryData?.entries ?? []
  const allowCustomAgents = registryData?.allowCustomAgents ?? true
  const canInstallCli = canInstallLocal && experimentalFeatureAgentsCli.value && allowCustomAgents

  // Fetch installed agents from DB (live query via PowerSync)
  // Includes: built-in, registry-installed, custom, and remote agents
  const { data: installedAgents = [] } = useQuery({
    queryKey: ['installed-agents'],
    query: toCompilableQuery(
      db
        .select()
        .from(agentsTable)
        .where(
          and(
            isNull(agentsTable.deletedAt),
            or(
              eq(agentsTable.type, 'built-in'),
              isNotNull(agentsTable.registryId),
              eq(agentsTable.distributionType, 'custom'),
              eq(agentsTable.type, 'remote'),
            ),
          ),
        ),
    ),
  })

  // Merge, filter, sort, group
  const allAgents = mergeRegistryWithInstalled(registryEntries, installedAgents as Agent[])
  const filtered = filterAgents(allAgents, searchQuery)
  const sorted = sortAgents(filtered)
  const sections = groupAgentsBySection(sorted, canInstallLocal)

  // ── Actions ───────────────────────────────────────────────────────────────

  const setBusy = (id: string, state: 'installing' | 'uninstalling' | null) => {
    setBusyAgents((prev) => {
      const next = new Map(prev)
      if (state) {
        next.set(id, state)
      } else {
        next.delete(id)
      }
      return next
    })
  }

  const handleInstallClick = useCallback((agent: MergedAgent) => {
    if (!agent.registryEntry) {
      return
    }
    setPendingInstallAgent(agent)
  }, [])

  const handleInstallConfirm = useCallback(async () => {
    const agent = pendingInstallAgent
    setPendingInstallAgent(null)
    if (!agent?.registryEntry) {
      return
    }

    setAgentErrors((prev) => {
      const next = new Map(prev)
      next.delete(agent.registryId)
      return next
    })
    setBusy(agent.registryId, 'installing')
    try {
      const entry = agent.registryEntry
      const { platform: getPlatformFn, arch: getArchFn } = await import('@tauri-apps/plugin-os')
      const [currentPlatform, currentArch] = await Promise.all([getPlatformFn(), getArchFn()])
      const platformKey = getRegistryPlatformKey(currentPlatform, currentArch)
      const preferred = getPreferredDistribution(entry.distribution, platformKey)

      if (!preferred) {
        throw new Error('No compatible distribution found for this platform')
      }

      // Remote agents don't need local installation — just save to DB
      if (preferred.type === 'remote') {
        await installRegistryAgent(db, {
          registryId: entry.id,
          name: entry.name,
          description: entry.description,
          version: entry.version,
          distributionType: 'remote',
          installPath: '',
          command: '',
        })
        return
      }

      let installResult: { installPath: string; command: string }

      switch (preferred.type) {
        case 'npx':
          installResult = await installNpxAgent({
            registryId: entry.id,
            packageName: preferred.target.package,
            checkRuntime: true,
          })
          break
        case 'binary':
          installResult = await installBinaryAgent({
            registryId: entry.id,
            archiveUrl: preferred.target.archive,
            cmd: preferred.target.cmd,
          })
          break
        case 'uvx':
          installResult = await installUvxAgent({
            registryId: entry.id,
            packageName: preferred.target.package,
            checkRuntime: true,
          })
          break
      }

      await installRegistryAgent(db, {
        registryId: entry.id,
        name: entry.name,
        description: entry.description,
        version: entry.version,
        distributionType: preferred.type,
        installPath: installResult.installPath,
        command: installResult.command,
        args: preferred.type === 'npx' ? preferred.target.args : undefined,
        packageName:
          preferred.type === 'npx'
            ? preferred.target.package
            : preferred.type === 'uvx'
              ? preferred.target.package
              : preferred.target.archive,
        icon: entry.icon ? 'globe' : undefined,
      })
    } catch (error) {
      console.error('Failed to install agent:', error)
      const message = error instanceof Error ? error.message : 'Installation failed'
      setAgentErrors((prev) => new Map(prev).set(agent.registryId, message))
    } finally {
      setBusy(agent.registryId, null)
      queryClient.invalidateQueries({ queryKey: ['installed-agents'] })
    }
  }, [db, queryClient, pendingInstallAgent])

  const handleUninstall = useCallback(
    async (agent: MergedAgent) => {
      if (!agent.agentId) {
        return
      }

      setBusy(agent.registryId, 'uninstalling')
      try {
        // Remove from disk (skip for custom and remote agents)
        if (!agent.isCustom && !agent.isRemote && agent.registryId) {
          await uninstallAgentFromDisk(agent.registryId)
        }
        await uninstallRegistryAgent(db, agent.agentId)
      } catch (error) {
        console.error('Failed to uninstall agent:', error)
      } finally {
        setBusy(agent.registryId, null)
        queryClient.invalidateQueries({ queryKey: ['installed-agents'] })
      }
    },
    [db, queryClient],
  )

  const handleToggle = useCallback(
    async (agent: MergedAgent, enabled: boolean) => {
      if (agent.agentId) {
        await toggleAgent(db, agent.agentId, enabled)
        queryClient.invalidateQueries({ queryKey: ['installed-agents'] })
        return
      }

      // Remote agents may not have a DB entry yet — create one to track enabled state
      if (agent.isRemote && agent.registryEntry) {
        await installRegistryAgent(db, {
          registryId: agent.registryEntry.id,
          name: agent.registryEntry.name,
          description: agent.registryEntry.description,
          version: agent.registryEntry.version,
          distributionType: 'remote',
          installPath: '',
          command: '',
        })
        if (!enabled) {
          await toggleAgent(db, `agent-registry-${agent.registryEntry.id}`, false)
        }
        queryClient.invalidateQueries({ queryKey: ['installed-agents'] })
      }
    },
    [db, queryClient],
  )

  const handleAddCustom = useCallback(
    async (params: AddAgentParams) => {
      if (params.type === 'local') {
        await addCustomAgent(db, params)
      } else {
        await addRemoteAgent(db, params)
      }
      setIsAddDialogOpen(false)
    },
    [db],
  )

  return (
    <div className="flex flex-col gap-6 p-4 pb-12 w-full max-w-[760px] mx-auto">
      <PageSearch onSearch={setSearchQuery}>
        <PageHeader title="Agents">
          <PageSearch.Button tooltip="Search" />
          {allowCustomAgents && (
            <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="icon" className="rounded-lg">
                  <Plus />
                </Button>
              </DialogTrigger>
              <AddCustomAgentDialogContent
                onAdd={handleAddCustom}
                onClose={() => setIsAddDialogOpen(false)}
                remoteOnly={!canInstallLocal}
              />
            </Dialog>
          )}
        </PageHeader>
        <PageSearch.Input placeholder="Search agents..." onSearch={setSearchQuery} />
      </PageSearch>

      <div className="grid gap-6">
        {sections.installed.length > 0 && (
          <AgentSection title="Installed">
            {sections.installed.map((agent) => (
              <AgentCard
                key={agent.registryId}
                agent={agent}
                proxyBase={cloudUrl.value}
                isInstalling={busyAgents.get(agent.registryId) === 'installing'}
                isUninstalling={busyAgents.get(agent.registryId) === 'uninstalling'}
                error={agentErrors.get(agent.registryId)}
                desktopOnly={!canInstallLocal}
                cliInstallBlocked={!canInstallCli}
                onInstall={handleInstallClick}
                onUninstall={handleUninstall}
                onToggle={handleToggle}
              />
            ))}
          </AgentSection>
        )}

        {sections.available.length > 0 && (
          <AgentSection title="Available">
            {sections.available.map((agent) => (
              <AgentCard
                key={agent.registryId}
                agent={agent}
                proxyBase={cloudUrl.value}
                isInstalling={busyAgents.get(agent.registryId) === 'installing'}
                isUninstalling={busyAgents.get(agent.registryId) === 'uninstalling'}
                error={agentErrors.get(agent.registryId)}
                desktopOnly={!canInstallLocal}
                cliInstallBlocked={!canInstallCli}
                onInstall={handleInstallClick}
                onUninstall={handleUninstall}
                onToggle={handleToggle}
              />
            ))}
          </AgentSection>
        )}

        {sections.unavailable.length > 0 && (
          <AgentSection title="Available on the Desktop App">
            {sections.unavailable.map((agent) => (
              <AgentCard
                key={agent.registryId}
                agent={agent}
                proxyBase={cloudUrl.value}
                isInstalling={busyAgents.get(agent.registryId) === 'installing'}
                isUninstalling={busyAgents.get(agent.registryId) === 'uninstalling'}
                error={agentErrors.get(agent.registryId)}
                desktopOnly={!canInstallLocal}
                cliInstallBlocked={!canInstallCli}
                onInstall={handleInstallClick}
                onUninstall={handleUninstall}
                onToggle={handleToggle}
              />
            ))}
          </AgentSection>
        )}

        {sorted.length === 0 && registryEntries.length > 0 && (
          <Card className="border-dashed border-2 border-muted-foreground/25 py-0 gap-0">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Terminal className="size-10 text-muted-foreground mb-4" />
              <h3 className="font-medium text-foreground mb-1">No agents match your search</h3>
              <p className="text-sm text-muted-foreground">Try a different search term.</p>
            </CardContent>
          </Card>
        )}

        {registryEntries.length === 0 && (
          <Card className="border-dashed border-2 border-muted-foreground/25 py-0 gap-0">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Bot className="size-10 text-muted-foreground mb-4" />
              <h3 className="font-medium text-foreground mb-1">Loading agents...</h3>
              <p className="text-sm text-muted-foreground">Fetching available agents from the ACP registry.</p>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={pendingInstallAgent !== null} onOpenChange={(open) => !open && setPendingInstallAgent(null)}>
        {pendingInstallAgent && (
          <InstallWarningDialogContent
            agentName={pendingInstallAgent.name}
            onConfirm={handleInstallConfirm}
            onCancel={() => setPendingInstallAgent(null)}
          />
        )}
      </Dialog>
    </div>
  )
}

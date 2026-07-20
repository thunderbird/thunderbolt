/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import dayjs from 'dayjs'
import { Loader2, MoreVertical, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import '@/lib/dayjs'
import { testAcpConnection as defaultTestAcpConnection } from '@/acp'
import { iconForAgent } from '@/components/agent-icon'
import { DetailDivider, DetailPanel, DetailSectionTitle } from '@/components/detail-panel'
import { AgentIconTile } from '@/components/settings/agents/agent-list-row'
import { EditableField, FieldLabel } from '@/components/settings/agents/editable-field'
import { inferTransport, validateAgentUrl } from '@/components/settings/agents/validate-agent-url'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, mutedIconButtonClass } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { useDatabase } from '@/contexts'
import { getAllMcpServers } from '@/dal'
import type { UpdateAgentPatch } from '@/dal/agents'
import { cn } from '@/lib/utils'
import { useLibrarySkills } from '@/skills/use-skills'
import type { Agent } from '@/types/acp'
import { acpEndpointLabel, agentProvenanceLine } from './agent-provenance'
import type { TestAcpConnectionFn } from './add-custom-agent-dialog'

/** On-demand probe result: the panel never polls on open — Status starts at
 *  `idle` and reflects the last explicit "Test connection" run. `error` holds
 *  the probe's user-facing failure reason (absent when reachable). */
type TestState = 'idle' | 'testing' | { isReachable: boolean; testedAt: string; error?: string }

type AgentDetailProps = {
  agent: Agent
  /** Gates the management affordances — only customs the current user owns are
   *  editable / removable. */
  currentUserId: string | null
  onClose: () => void
  /** Called after a custom agent is removed so the parent closes the panel. */
  onRemoved: () => void
  /** Persist a patch to the custom agent (name / endpoint / description /
   *  enabled). Only invoked for editable agents. */
  onUpdate: (patch: UpdateAgentPatch) => Promise<void>
  /** Soft-delete the custom agent. */
  onDelete: () => Promise<void>
  /** Injectable probe for the on-demand Test (tests stub it). Typed by the
   *  narrow shape this panel consumes, so test fakes need no casts. */
  testAcpConnection?: TestAcpConnectionFn
}

/** The three presentation flavors an agent can take in this panel. */
type AgentFlavor = 'built-in' | 'system' | 'custom'

const agentFlavor = (agent: Agent): AgentFlavor => {
  if (agent.type === 'built-in') {
    return 'built-in'
  }
  return agent.isSystem === 1 ? 'system' : 'custom'
}

/**
 * Slide-in detail panel for a single agent, one shared anatomy for all three
 * flavors (built-in / system / custom): identity header with provenance
 * subtitle, scrollable body sections separated by hairline dividers (same
 * transparent-on-surface idiom as the skills detail), and management tucked
 * into the ⋯ menu. Built-in and system agents are read-only; customs edit
 * name / endpoint / description inline and can be removed.
 */
export const AgentDetail = ({
  agent,
  currentUserId,
  onClose,
  onRemoved,
  onUpdate,
  onDelete,
  testAcpConnection = defaultTestAcpConnection,
}: AgentDetailProps) => {
  const Icon = iconForAgent(agent)
  const flavor = agentFlavor(agent)
  const isEditable = flavor === 'custom' && !!currentUserId && agent.userId === currentUserId
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const handleRemove = async () => {
    setRemoveError(null)
    try {
      await onDelete()
    } catch (error) {
      // Keep the confirm dialog open so the failure is visible and retryable.
      console.error('Failed to remove agent', error)
      setRemoveError("Couldn't remove the agent. Please try again.")
      return
    }
    setConfirmOpen(false)
    onRemoved()
  }

  const managementMenu = isEditable && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="More" className={mutedIconButtonClass}>
          <MoreVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuItem onClick={() => setConfirmOpen(true)} className="cursor-pointer">
          <Trash2 />
          Remove agent
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <DetailPanel
      icon={
        <AgentIconTile>
          {/* The logo reads slightly smaller than the lucide glyphs at equal
              box size, so it gets a half-step bump. */}
          <Icon
            className={cn('text-muted-foreground', agent.type === 'built-in' ? 'size-5.5' : 'size-5')}
            aria-hidden="true"
          />
        </AgentIconTile>
      }
      title={agent.name}
      subtitle={agentProvenanceLine(agent)}
      actions={managementMenu}
      onClose={onClose}
    >
      {flavor === 'built-in' && <BuiltInBody />}
      {flavor === 'system' && <SystemBody agent={agent} />}
      {flavor === 'custom' && (
        <CustomBody agent={agent} isEditable={isEditable} onUpdate={onUpdate} testAcpConnection={testAcpConnection} />
      )}

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open)
          if (!open) {
            setRemoveError(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {agent.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the connection from Thunderbolt only. Nothing on the remote server is changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError && (
            <p role="alert" className="text-sm text-destructive">
              {removeError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void handleRemove()}>
              Remove agent
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailPanel>
  )
}

/** Read-only info view for the built-in Thunderbolt agent: what it is, plus
 *  live links into the Library surfaces it draws on. */
const BuiltInBody = () => {
  const db = useDatabase()
  const { skills } = useLibrarySkills()
  const enabledSkills = skills.filter((s) => s.enabled === 1).length
  const { data: mcpServers = [] } = useQuery({
    queryKey: ['mcp-servers'],
    query: toCompilableQuery(getAllMcpServers(db)),
  })

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2">
        <DetailSectionTitle>About</DetailSectionTitle>
        <p className="text-base leading-snug text-foreground">
          Thunderbolt is the agent built into the app — always here, no setup needed. It draws on everything you have
          enabled in your library (skills, integrations, and MCP servers) to help with whatever you are working on.
        </p>
      </div>

      <DetailDivider />

      <div className="flex flex-col gap-4">
        <DetailSectionTitle>What it uses</DetailSectionTitle>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <FieldLabel>Skills</FieldLabel>
            <Link
              to="/settings/skills"
              className="w-fit text-base text-primary underline underline-offset-4 transition-colors hover:text-foreground"
            >
              {enabledSkills} {enabledSkills === 1 ? 'skill' : 'skills'}
            </Link>
          </div>
          <div className="flex flex-col gap-1">
            <FieldLabel>MCP servers</FieldLabel>
            <Link
              to="/settings/mcp-servers"
              className="w-fit text-base text-primary underline underline-offset-4 transition-colors hover:text-foreground"
            >
              {mcpServers.length} {mcpServers.length === 1 ? 'MCP server' : 'MCP servers'}
            </Link>
          </div>
          <div className="flex flex-col gap-1">
            <FieldLabel>Integrations</FieldLabel>
            <Link
              to="/settings/integrations"
              className="w-fit text-base text-primary underline underline-offset-4 transition-colors hover:text-foreground"
            >
              Manage integrations
            </Link>
          </div>
        </div>
      </div>
    </>
  )
}

/** Read-only info view for a deployment-provided system agent. */
const SystemBody = ({ agent }: { agent: Agent }) => (
  <>
    {agent.description && (
      <>
        <div className="flex shrink-0 flex-col gap-2">
          <DetailSectionTitle>About</DetailSectionTitle>
          <p className="whitespace-pre-wrap text-base leading-snug text-foreground">{agent.description}</p>
        </div>
        <DetailDivider />
      </>
    )}
    <div className="flex flex-col gap-4">
      <DetailSectionTitle>Connection</DetailSectionTitle>
      <div className="flex flex-col gap-1">
        <FieldLabel>Endpoint</FieldLabel>
        <p className="truncate text-base text-foreground">{acpEndpointLabel(agent)}</p>
      </div>
      <p className="text-sm text-muted-foreground">Managed by your deployment — always available, no setup needed.</p>
    </div>
  </>
)

/** Management view for a user-connected custom agent: inline-editable
 *  configuration plus an on-demand connection test. */
const CustomBody = ({
  agent,
  isEditable,
  onUpdate,
  testAcpConnection,
}: {
  agent: Agent
  isEditable: boolean
  onUpdate: AgentDetailProps['onUpdate']
  testAcpConnection: NonNullable<AgentDetailProps['testAcpConnection']>
}) => {
  const [testResult, setTestResult] = useState<TestState>('idle')
  const [enabledError, setEnabledError] = useState<string | null>(null)
  const isWebSocket = agent.transport === 'websocket'

  const handleEnabledChange = async (next: boolean) => {
    setEnabledError(null)
    try {
      await onUpdate({ enabled: next ? 1 : 0 })
    } catch (error) {
      // The optimistic Switch reverts on the next render; say why.
      console.error('Failed to update agent enabled state', error)
      setEnabledError("Couldn't update. Please try again.")
    }
  }

  const handleTest = async () => {
    if (!agent.url) {
      return
    }
    setTestResult('testing')
    const probe = await testAcpConnection({ url: agent.url })
    const testedAt = new Date().toISOString()
    setTestResult(
      probe.success ? { isReachable: true, testedAt } : { isReachable: false, testedAt, error: probe.error },
    )
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <DetailSectionTitle>Configuration</DetailSectionTitle>
        <EditableField
          id="agent-detail-name"
          label="Name"
          value={agent.name}
          isEditable={isEditable}
          onSave={(name) => onUpdate({ name })}
        />
        <EditableField
          id="agent-detail-endpoint"
          label="Endpoint"
          value={agent.url ?? ''}
          isEditable={isEditable}
          validate={(url) => {
            const validation = validateAgentUrl(url)
            return 'error' in validation ? validation.error : null
          }}
          onSave={(url) => {
            // Re-infer the transport (ws vs iroh) for the validated draft —
            // the same rule the add dialog applies. `validate` above already
            // rejected anything without a transport, so this cannot be null;
            // the guard exists for narrowing and fails loudly if the two
            // validators ever drift.
            const transport = inferTransport(url)
            if (transport === null) {
              throw new Error(`Endpoint URL has no supported transport: ${url}`)
            }
            return onUpdate({ url, transport })
          }}
          inputProps={{ autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }}
        />
        <EditableField
          id="agent-detail-description"
          label="Description"
          value={agent.description ?? ''}
          isEditable={isEditable}
          allowEmpty
          placeholder="Optional"
          onSave={(description) => onUpdate({ description: description === '' ? null : description })}
        />
        {isEditable && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <FieldLabel>Enabled</FieldLabel>
                <p className="text-sm text-muted-foreground">Disabled agents stay out of the chat agent picker.</p>
              </div>
              <Switch
                checked={agent.enabled === 1}
                onCheckedChange={(next) => void handleEnabledChange(next)}
                aria-label={agent.enabled === 1 ? `Disable ${agent.name}` : `Enable ${agent.name}`}
              />
            </div>
            {enabledError && (
              <p role="alert" className="text-sm text-destructive">
                {enabledError}
              </p>
            )}
          </div>
        )}
      </div>

      <DetailDivider />

      <div className="flex flex-col gap-3">
        <DetailSectionTitle>Connection</DetailSectionTitle>
        {isWebSocket ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-3">
              <TestStatus result={testResult} />
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleTest()}
                disabled={testResult === 'testing'}
                className="bg-card"
              >
                Test connection
              </Button>
            </div>
            {typeof testResult === 'object' && testResult.error && (
              <p className="text-sm text-muted-foreground">{testResult.error}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Peer-to-peer via iroh — the connection is verified when a chat starts.
          </p>
        )}
      </div>
    </>
  )
}

/** The Status line's dot + label, derived from the last explicit test run. */
const TestStatus = ({ result }: { result: TestState }) => {
  if (result === 'testing') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        Testing…
      </span>
    )
  }
  if (result === 'idle') {
    return <span className="text-sm text-muted-foreground">Not tested</span>
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-sm font-medium',
        result.isReachable ? 'text-green-600 dark:text-green-500' : 'text-destructive',
      )}
    >
      <span
        className={cn('inline-block size-2 rounded-full', result.isReachable ? 'bg-green-500' : 'bg-destructive')}
        aria-hidden="true"
      />
      {`${result.isReachable ? 'Reachable' : 'Unreachable'} ${dayjs(result.testedAt).fromNow()}`}
    </span>
  )
}

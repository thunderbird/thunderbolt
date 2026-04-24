import { Elysia } from 'elysia'
import { getSettings, getHaystackPipelines, getEnabledAgentIds } from '@/config/settings'
import { createHaystackProvider } from './haystack-provider'
import type { AgentProvider } from './types'

const acpRegistryUrl = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
const registryCacheTtlMs = 60 * 60 * 1000 // 1 hour

type RegistryEntry = {
  id: string
  name: string
  version: string
  description: string
  authors: string[]
  license: string
  distribution: Record<string, unknown>
  icon?: string
  repository?: string
  website?: string
}

type RegistryResponse = {
  version: string
  agents: RegistryEntry[]
  extensions: unknown[]
  allowCustomAgents: boolean
}

// ── Registry cache ────────────────────────────────────────────────────────────

// In-memory cache — single-process only. Cache is not shared across worker processes.
let registryCache: { data: RegistryEntry[]; fetchedAt: number } | null = null

const fetchRegistryEntries = async (): Promise<RegistryEntry[]> => {
  if (registryCache && Date.now() - registryCache.fetchedAt < registryCacheTtlMs) {
    return registryCache.data
  }

  try {
    const response = await fetch(acpRegistryUrl)
    if (!response.ok) {
      console.warn(`Failed to fetch ACP registry: ${response.status}`)
      return registryCache?.data ?? []
    }
    const json = (await response.json()) as RegistryResponse
    const entries = Array.isArray(json?.agents) ? json.agents : []
    registryCache = { data: entries, fetchedAt: Date.now() }
    return entries
  } catch (error) {
    console.warn('Failed to fetch ACP registry:', error)
    return registryCache?.data ?? []
  }
}

// ── Remote agent → registry entry conversion ──────────────────────────────────

/** Swaps http(s) → ws(s) and keeps the host + /v1 prefix. */
const getWsBaseUrl = (request: Request): string => {
  const url = new URL(request.url)
  const forwardedProto = request.headers.get('x-forwarded-proto')
  const isSecure = forwardedProto === 'https' || url.protocol === 'https:'
  const wsProtocol = isSecure ? 'wss:' : 'ws:'
  return `${wsProtocol}//${url.host}/v1`
}

const remoteAgentsToRegistryEntries = (providers: AgentProvider[]): RegistryEntry[] =>
  providers.flatMap((p) =>
    p.getAgents().map((agent) => ({
      id: agent.id,
      name: agent.name,
      version: '1.0.0',
      description: '',
      authors: [],
      license: 'proprietary',
      distribution: {
        remote: {
          url: agent.url,
          transport: agent.transport,
          icon: agent.icon,
        },
      },
    })),
  )

// ── Routes ────────────────────────────────────────────────────────────────────

export const createAgentsRoutes = () => {
  const settings = getSettings()
  const pipelines = getHaystackPipelines(settings)

  const router = new Elysia({ prefix: '/agents' })

  router.get('/', async ({ request }) => {
    const wsBaseUrl = getWsBaseUrl(request)
    const enabledIds = getEnabledAgentIds(getSettings())

    // Fetch ACP registry entries
    const registryEntries = await fetchRegistryEntries()

    // Convert remote agents to registry format
    const providers: AgentProvider[] = [...(pipelines.length > 0 ? [createHaystackProvider(pipelines, wsBaseUrl)] : [])]
    const remoteEntries = remoteAgentsToRegistryEntries(providers)

    // Merge: registry entries + remote entries
    const allAgents = [...registryEntries, ...remoteEntries]
    const agents = enabledIds ? allAgents.filter((a) => enabledIds.includes(a.id)) : allAgents

    return {
      version: '1.0.0',
      agents,
      extensions: [],
      allowCustomAgents: getSettings().allowCustomAgents,
    } satisfies RegistryResponse
  })

  return router
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type RegistryPlatformKey =
  | 'darwin-aarch64'
  | 'darwin-x86_64'
  | 'linux-aarch64'
  | 'linux-x86_64'
  | 'windows-aarch64'
  | 'windows-x86_64'

export type BinaryTarget = {
  archive: string
  cmd: string
  args?: string[]
}

export type NpxDistribution = {
  package: string
  args?: string[]
  env?: Record<string, string>
}

export type UvxDistribution = {
  package: string
  args?: string[]
}

export type RemoteDistribution = {
  url: string
  transport: string
  icon?: string
}

export type RegistryDistribution = {
  binary?: Record<string, BinaryTarget>
  npx?: NpxDistribution
  uvx?: UvxDistribution
  remote?: RemoteDistribution
}

export type RegistryEntry = {
  id: string
  name: string
  version: string
  description: string
  authors: string[]
  license: string
  distribution: RegistryDistribution
  icon?: string
  repository?: string
  website?: string
}

export type PreferredDistribution =
  | { type: 'binary'; target: BinaryTarget }
  | { type: 'npx'; target: NpxDistribution }
  | { type: 'uvx'; target: UvxDistribution }
  | { type: 'remote'; target: RemoteDistribution }

type RegistryJson = {
  version: string
  agents: RegistryEntry[]
  extensions: unknown[]
}

// ── Platform mapping ──────────────────────────────────────────────────────────

const platformMap: Record<string, string> = {
  macos: 'darwin',
  linux: 'linux',
  windows: 'windows',
}

const validArches = new Set(['aarch64', 'x86_64'])

/**
 * Maps a Tauri platform + arch to the registry's platform key format.
 * Returns null if the combination is unsupported.
 */
export const getRegistryPlatformKey = (platform: string, arch: string): RegistryPlatformKey | null => {
  const mappedPlatform = platformMap[platform]
  if (!mappedPlatform || !validArches.has(arch)) {
    return null
  }
  return `${mappedPlatform}-${arch}` as RegistryPlatformKey
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parses raw registry JSON into an array of RegistryEntry objects.
 * Returns an empty array on any parse failure.
 */
export const parseRegistryJson = (raw: string): RegistryEntry[] => {
  if (!raw) {
    return []
  }

  try {
    const data = JSON.parse(raw) as RegistryJson
    if (!Array.isArray(data?.agents)) {
      return []
    }
    return data.agents
  } catch {
    return []
  }
}

// ── Platform availability ─────────────────────────────────────────────────────

/**
 * Checks if a registry agent has a distribution that works on the given platform.
 * NPX and UVX agents work on any platform (they just need the runtime).
 * Binary agents only work on platforms listed in their distribution.
 */
export const isAgentAvailableForPlatform = (entry: RegistryEntry, platformKey: RegistryPlatformKey | null): boolean => {
  const { distribution } = entry

  // Remote agents work on any platform
  if (distribution.remote) {
    return true
  }

  // NPX and UVX work on any platform
  if (distribution.npx || distribution.uvx) {
    return true
  }

  // Binary requires a matching platform
  if (distribution.binary) {
    if (!platformKey) {
      return false
    }
    return platformKey in distribution.binary
  }

  // No distribution at all
  return false
}

// ── Distribution preference ───────────────────────────────────────────────────

/**
 * Returns the preferred distribution for a given platform.
 * Preference order: binary (if platform matches) > npx > uvx.
 */
export const getPreferredDistribution = (
  distribution: RegistryDistribution,
  platformKey: RegistryPlatformKey | null,
): PreferredDistribution | null => {
  // Remote agents always use remote distribution
  if (distribution.remote) {
    return { type: 'remote', target: distribution.remote }
  }

  // Prefer binary if available for this platform
  if (platformKey && distribution.binary?.[platformKey]) {
    return { type: 'binary', target: distribution.binary[platformKey] }
  }

  // Fall back to npx
  if (distribution.npx) {
    return { type: 'npx', target: distribution.npx }
  }

  // Fall back to uvx
  if (distribution.uvx) {
    return { type: 'uvx', target: distribution.uvx }
  }

  return null
}

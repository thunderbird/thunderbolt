import { Command } from '@tauri-apps/plugin-shell'
import { appDataDir } from '@tauri-apps/api/path'
import { exists, mkdir, remove, writeFile } from '@tauri-apps/plugin-fs'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

// ── Path helpers ──────────────────────────────────────────────────────────────

export const getAgentsDir = async (): Promise<string> => {
  const base = await appDataDir()
  const normalized = base.endsWith('/') ? base.slice(0, -1) : base
  return `${normalized}/agents`
}

export const getAgentInstallPath = async (registryId: string): Promise<string> => {
  const dir = await getAgentsDir()
  return `${dir}/${registryId}`
}

// ── Runtime checks ────────────────────────────────────────────────────────────

const which = async (command: string): Promise<boolean> => {
  const cmd = Command.create('which', [command])
  const output = await cmd.execute()
  return output.code === 0
}

/**
 * Checks if the runtime needed for a distribution type is available.
 * Binary agents need no runtime. NPX needs npm/node. UVX needs uv.
 */
export const checkRuntimeAvailable = async (distributionType: string): Promise<boolean> => {
  switch (distributionType) {
    case 'binary':
      return true
    case 'npx':
      return which('npm')
    case 'uvx':
      return which('uv')
    default:
      return false
  }
}

// ── NPX installation ─────────────────────────────────────────────────────────

type NpxInstallParams = {
  registryId: string
  packageName: string
  checkRuntime?: boolean
}

type InstallResult = {
  installPath: string
  command: string
}

/**
 * Extracts the binary name from an NPX package name.
 * e.g., "@agentclientprotocol/claude-agent-acp@0.24.2" → "claude-agent-acp"
 * e.g., "@scope/pkg@1.0.0" → "pkg"
 * e.g., "simple-pkg@1.0.0" → "simple-pkg"
 */
const extractBinName = (packageName: string): string => {
  // Remove version suffix
  const withoutVersion = packageName.replace(/@[\d.]+(-[a-z0-9.]+)?$/, '')
  // Get the last segment (after the last /)
  const parts = withoutVersion.split('/')
  return parts[parts.length - 1]
}

export const installNpxAgent = async ({
  registryId,
  packageName,
  checkRuntime,
}: NpxInstallParams): Promise<InstallResult> => {
  if (checkRuntime) {
    const available = await checkRuntimeAvailable('npx')
    if (!available) {
      throw new Error('Node.js is required to install this agent. Please install Node.js and try again.')
    }
  }

  const installPath = await getAgentInstallPath(registryId)
  await mkdir(installPath, { recursive: true })

  const cmd = Command.create('npm', ['install', '--prefix', installPath, packageName])
  const output = await cmd.execute()

  if (output.code !== 0) {
    // Clean up on failure
    try {
      await remove(installPath, { recursive: true })
    } catch {
      // Ignore cleanup errors
    }
    throw new Error(`npm install failed: ${output.stderr}`)
  }

  const binName = extractBinName(packageName)
  const command = `${installPath}/node_modules/.bin/${binName}`

  return { installPath, command }
}

// ── Binary installation ───────────────────────────────────────────────────────

type BinaryInstallParams = {
  registryId: string
  archiveUrl: string
  cmd: string
}

export const installBinaryAgent = async ({
  registryId,
  archiveUrl,
  cmd,
}: BinaryInstallParams): Promise<InstallResult> => {
  const installPath = await getAgentInstallPath(registryId)
  await mkdir(installPath, { recursive: true })

  // Download archive
  const response = await tauriFetch(archiveUrl)
  if (!response.ok) {
    throw new Error(`Failed to download agent archive: ${response.status ?? 'unknown error'}`)
  }

  const buffer = await response.arrayBuffer()
  const archiveName = archiveUrl.endsWith('.zip') ? 'archive.zip' : 'archive.tar.gz'
  const archivePath = `${installPath}/${archiveName}`

  await writeFile(archivePath, new Uint8Array(buffer))

  // Extract
  const extractCmd = archiveName.endsWith('.zip')
    ? Command.create('unzip', [archivePath, '-d', installPath])
    : Command.create('tar', ['-xzf', archivePath, '-C', installPath])

  const extractOutput = await extractCmd.execute()
  if (extractOutput.code !== 0) {
    try {
      await remove(installPath, { recursive: true })
    } catch {
      // Ignore cleanup errors
    }
    throw new Error(`Failed to extract agent archive: ${extractOutput.stderr}`)
  }

  // Remove archive after extraction
  try {
    await remove(archivePath)
  } catch {
    // Non-critical
  }

  // Resolve command path — cmd is relative like "./goose"
  const binaryName = cmd.replace(/^\.\//, '')
  const command = `${installPath}/${binaryName}`

  return { installPath, command }
}

// ── UVX installation ──────────────────────────────────────────────────────────

type UvxInstallParams = {
  registryId: string
  packageName: string
  checkRuntime?: boolean
}

export const installUvxAgent = async ({
  registryId,
  packageName,
  checkRuntime,
}: UvxInstallParams): Promise<InstallResult> => {
  if (checkRuntime) {
    const available = await checkRuntimeAvailable('uvx')
    if (!available) {
      throw new Error('uv (Python package manager) is required to install this agent. Please install uv and try again.')
    }
  }

  const installPath = await getAgentInstallPath(registryId)
  await mkdir(installPath, { recursive: true })

  const cmd = Command.create('uv', ['tool', 'install', '--directory', installPath, packageName])
  const output = await cmd.execute()

  if (output.code !== 0) {
    try {
      await remove(installPath, { recursive: true })
    } catch {
      // Ignore cleanup errors
    }
    throw new Error(`uv tool install failed: ${output.stderr}`)
  }

  // The binary name is typically the package name without version
  const binName = packageName.replace(/@[\d.]+(-[a-z0-9.]+)?$/, '').replace(/==[\d.]+$/, '')
  const command = `${installPath}/bin/${binName}`

  return { installPath, command }
}

// ── Uninstall ─────────────────────────────────────────────────────────────────

export const uninstallAgent = async (registryId: string): Promise<void> => {
  const installPath = await getAgentInstallPath(registryId)
  const pathExists = await exists(installPath)
  if (!pathExists) {
    return
  }
  await remove(installPath, { recursive: true })
}

// ── Status check ──────────────────────────────────────────────────────────────

export const isAgentInstalled = async (registryId: string): Promise<boolean> => {
  const installPath = await getAgentInstallPath(registryId)
  return exists(installPath)
}

import type { Stream } from '@agentclientprotocol/sdk'
import type { AgentConfig } from './types'
import { createStdioStream, type SubprocessHandle, type SubprocessSpawner } from './stdio-stream'

type LocalAgentConnectionOptions = {
  agentConfig: AgentConfig
  spawner: SubprocessSpawner
}

type LocalAgentConnection = {
  stream: Stream
  process: SubprocessHandle
  cleanup: () => Promise<void>
}

/**
 * Resolves the spawn command and args for an agent based on its distribution type.
 *
 * - NPX-installed agents: spawn via `node` with the script path as first arg
 * - UVX-installed agents: spawn via `uvx` with the package name as first arg
 * - Custom/PATH agents: spawn the command directly
 * - Binary agents: spawn the command directly (requires shell:allow-spawn entry or Rust spawner)
 */
const resolveSpawnCommand = (agentConfig: AgentConfig): { command: string; args: string[] } => {
  const command = agentConfig.command
  if (!command) {
    throw new Error(`Agent "${agentConfig.name}" has no command configured`)
  }

  const baseArgs = agentConfig.args ?? []
  const distType = (agentConfig as any).distributionType as string | undefined

  // NPX-installed agents: use node to run the installed script
  if (distType === 'npx' && (agentConfig as any).installPath) {
    return { command: 'node', args: [command, ...baseArgs] }
  }

  // UVX-installed agents: use uvx to run the installed package
  if (distType === 'uvx' && (agentConfig as any).packageName) {
    const packageName = (agentConfig as any).packageName as string
    return { command: 'uvx', args: [packageName, ...baseArgs] }
  }

  // Custom agents and binary agents: spawn directly
  return { command, args: baseArgs }
}

/**
 * Spawn a local CLI agent and create an ACP connection to it.
 * Returns the stream for ClientSideConnection and a cleanup function.
 */
export const connectToLocalAgent = async ({
  agentConfig,
  spawner,
}: LocalAgentConnectionOptions): Promise<LocalAgentConnection> => {
  const { command, args } = resolveSpawnCommand(agentConfig)

  const handle = await spawner.spawn(command, args)
  const stream = createStdioStream(handle)

  // Set up exit handler
  handle.onExit((code) => {
    console.info(`Agent "${agentConfig.name}" exited with code ${code}`)
  })

  const cleanup = async () => {
    await handle.kill()
  }

  return { stream, process: handle, cleanup }
}

// Export for testing
export { resolveSpawnCommand }

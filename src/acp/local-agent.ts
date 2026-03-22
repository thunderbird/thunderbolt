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
 * Spawn a local CLI agent and create an ACP connection to it.
 * Returns the stream for ClientSideConnection and a cleanup function.
 */
export const connectToLocalAgent = async ({
  agentConfig,
  spawner,
}: LocalAgentConnectionOptions): Promise<LocalAgentConnection> => {
  const command = agentConfig.command
  if (!command) {
    throw new Error(`Agent "${agentConfig.name}" has no command configured`)
  }

  const args = agentConfig.args ?? []

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

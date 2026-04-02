import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk'

/**
 * Abstraction for a subprocess that communicates over stdio.
 * In Tauri, this would be backed by @tauri-apps/plugin-shell Command.
 * In tests, this can be mocked.
 */
export type SubprocessHandle = {
  stdin: WritableStream<Uint8Array>
  stdout: ReadableStream<Uint8Array>
  kill: () => Promise<void>
  onExit: (callback: (code: number | null) => void) => void
  onStderr?: (callback: (data: string) => void) => void
}

/**
 * Abstraction for spawning subprocesses.
 * Allows swapping between Tauri shell, Node child_process, or mocks.
 */
export type SubprocessSpawner = {
  spawn: (command: string, args: string[]) => Promise<SubprocessHandle>
  which: (command: string) => Promise<string | null>
}

/**
 * Create an ACP Stream from a subprocess's stdio.
 * The subprocess must speak ACP (newline-delimited JSON-RPC over stdio).
 */
export const createStdioStream = (handle: SubprocessHandle): Stream => {
  return ndJsonStream(handle.stdin, handle.stdout)
}

/**
 * Check if a CLI agent is available on the system.
 */
export const isAgentAvailable = async (spawner: SubprocessSpawner, command: string): Promise<boolean> => {
  const path = await spawner.which(command)
  return path !== null
}

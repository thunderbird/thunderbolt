import { invoke } from '@tauri-apps/api/core'
import type { Agent } from '@/types'

/**
 * Spawn an installed agent using the secure Tauri command.
 * The Rust command validates the binary path is under $APPDATA/agents/.
 */
export const spawnInstalledAgent = async (
  binaryPath: string,
  args: string[],
  env?: Record<string, string>,
): Promise<number> => {
  const pid = await invoke<number>('spawn_agent', {
    binaryPath,
    args,
    env: env ?? {},
  })
  return pid
}

/**
 * Checks if an agent is a registry-installed agent (has an installPath).
 * Used to decide between spawnInstalledAgent and regular shell spawn.
 */
export const isInstalledAgent = (agent: Agent): boolean => {
  return !!agent.installPath
}

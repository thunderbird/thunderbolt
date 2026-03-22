import { isTauri, isDesktop } from '@/lib/platform'
import { localAgentCandidates, hashAgent } from '@/defaults/agents'
import { agentsTable } from '@/db/tables'
import { eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { Agent } from '@/types'

/**
 * Check if a command exists on the system PATH using Tauri shell.
 * Returns null on web or if the command is not found.
 */
const commandExists = async (command: string): Promise<boolean> => {
  if (!isTauri()) {
    return false
  }

  try {
    const { Command } = await import('@tauri-apps/plugin-shell')
    const cmd = Command.create('which', [command])
    const output = await cmd.execute()
    return output.code === 0
  } catch {
    return false
  }
}

/**
 * Discover local CLI agents available on this machine and upsert them into the DB.
 * Only runs on Tauri desktop — returns immediately on web/mobile.
 */
export const discoverAndSeedLocalAgents = async (db: AnyDrizzleDatabase): Promise<Agent[]> => {
  if (!isTauri() || !isDesktop()) {
    return []
  }

  const discovered: Agent[] = []

  for (const candidate of localAgentCandidates) {
    if (!candidate.command) {
      continue
    }

    const exists = await commandExists(candidate.command)
    if (!exists) {
      continue
    }

    // Check if already in DB
    const existing = await db.select().from(agentsTable).where(eq(agentsTable.id, candidate.id))

    if (existing.length === 0) {
      await db.insert(agentsTable).values({
        ...candidate,
        defaultHash: hashAgent(candidate),
      })
    }

    discovered.push(candidate)
  }

  return discovered
}

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

  // Check all candidates in parallel
  const candidatesWithCommand = localAgentCandidates.filter((c) => c.command)
  const existenceResults = await Promise.all(candidatesWithCommand.map((c) => commandExists(c.command!)))

  const discovered: Agent[] = []

  for (let i = 0; i < candidatesWithCommand.length; i++) {
    if (!existenceResults[i]) {
      continue
    }

    const candidate = candidatesWithCommand[i]

    // Upsert: insert if missing, or update if defaults changed
    const existing = await db.select().from(agentsTable).where(eq(agentsTable.id, candidate.id))
    const candidateHash = hashAgent(candidate)

    if (existing.length === 0) {
      await db.insert(agentsTable).values({
        ...candidate,
        defaultHash: candidateHash,
      })
    } else if (existing[0].defaultHash !== candidateHash) {
      await db
        .update(agentsTable)
        .set({ ...candidate, defaultHash: candidateHash })
        .where(eq(agentsTable.id, candidate.id))
    }

    discovered.push(candidate)
  }

  return discovered
}

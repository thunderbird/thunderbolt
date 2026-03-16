import { handlePRThreads, handlePRReply } from './cli/pr-threads'
import { handlePRComments, handlePRMinimize } from './cli/pr-comments'
import { handleCIStatus, handleCILogs } from './cli/ci'

type SubcommandHandler = (args: string[]) => Promise<void>

const SUBCOMMANDS: Record<string, { handler: SubcommandHandler; description: string }> = {
  'pr-threads': {
    handler: handlePRThreads,
    description: 'List/resolve PR review threads (--pr N [--unresolved] [--resolve-all] [--json])',
  },
  'pr-reply': {
    handler: handlePRReply,
    description: 'Reply to a review thread comment (--pr N --comment-id ID --body "text")',
  },
  'pr-comments': {
    handler: handlePRComments,
    description: 'List PR issue-level comments (--pr N [--actionable] [--json])',
  },
  'pr-minimize': {
    handler: handlePRMinimize,
    description: 'Minimize actionable issue comments (--pr N)',
  },
  'ci-status': {
    handler: handleCIStatus,
    description: 'Get CI check status (--pr N [--json])',
  },
  'ci-logs': {
    handler: handleCILogs,
    description: 'Get failed CI run logs ([--branch name])',
  },
}

const printUsage = () => {
  console.log('Usage: bun run .thunderbot/cli.ts <subcommand> [options]\n')
  console.log('Subcommands:')
  for (const [name, { description }] of Object.entries(SUBCOMMANDS)) {
    console.log(`  ${name.padEnd(16)} ${description}`)
  }
}

/** Parse subcommand from process.argv and route to handler */
const main = async () => {
  const [subcommand, ...args] = process.argv.slice(2)

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printUsage()
    process.exit(subcommand ? 0 : 1)
  }

  const entry = SUBCOMMANDS[subcommand]
  if (!entry) {
    console.error(`Unknown subcommand: ${subcommand}\n`)
    printUsage()
    process.exit(1)
  }

  try {
    await entry.handler(args)
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

if (import.meta.main) {
  await main()
}

export { main, SUBCOMMANDS }

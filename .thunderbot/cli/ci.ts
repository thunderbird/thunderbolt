import { gh, runCommand, getCurrentBranch, parseRequiredPR } from './repo'

type CheckResult = {
  name: string
  status: string
  elapsed: string
}

type CIStatusResult = {
  passing: boolean
  checks: CheckResult[]
  raw: string
}

/** Get CI check status for a PR by parsing gh pr checks output */
export const getCIStatus = async (prNumber: number): Promise<CIStatusResult> => {
  const result = await runCommand('gh', ['pr', 'checks', String(prNumber)])

  if (result.exitCode !== 0 && !result.stdout) {
    throw new Error(`gh pr checks failed: ${result.stderr}`)
  }

  const lines = result.stdout.split('\n').filter(Boolean)
  const checks: CheckResult[] = lines.map((line) => {
    const parts = line.split('\t')
    return {
      name: parts[0]?.trim() ?? '',
      status: parts[1]?.trim() ?? '',
      elapsed: parts[2]?.trim() ?? '',
    }
  })

  const passing = result.exitCode === 0
  return { passing, checks, raw: result.stdout }
}

/** Get failed CI logs for the latest run on a branch */
export const getFailedLogs = async (branch?: string): Promise<string> => {
  const targetBranch = branch ?? (await getCurrentBranch())

  const runIdRaw = await gh([
    'run',
    'list',
    '--branch',
    targetBranch,
    '--limit',
    '1',
    '--json',
    'databaseId',
    '--jq',
    '.[0].databaseId',
  ])

  const runId = runIdRaw.trim()
  if (!runId) {
    throw new Error(`No CI runs found for branch: ${targetBranch}`)
  }

  const result = await runCommand('gh', ['run', 'view', runId, '--log-failed'])
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get logs for run ${runId}: ${result.stderr}`)
  }

  return result.stdout
}


/** CLI handler for ci-status subcommand */
export const handleCIStatus = async (args: string[]): Promise<void> => {
  const prNumber = parseRequiredPR(args)
  const json = args.includes('--json')
  const status = await getCIStatus(prNumber)

  if (json) {
    console.log(JSON.stringify(status, null, 2))
  } else {
    console.log(status.passing ? 'CI: PASSING' : 'CI: FAILING')
    console.log(status.raw)
  }
}

/** CLI handler for ci-logs subcommand */
export const handleCILogs = async (args: string[]): Promise<void> => {
  const branchIdx = args.indexOf('--branch')
  const branch = branchIdx !== -1 && branchIdx + 1 < args.length ? args[branchIdx + 1] : undefined
  const logs = await getFailedLogs(branch)
  console.log(logs)
}


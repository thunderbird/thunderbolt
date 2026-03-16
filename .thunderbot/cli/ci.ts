import { gh, runCommand, getCurrentBranch } from './repo'

type CheckResult = {
  name: string
  status: string
  conclusion: string
}

type CIStatusResult = {
  passing: boolean
  checks: CheckResult[]
  raw: string
}

/** Get CI check status for a PR by parsing gh pr checks output */
export const getCIStatus = async (prNumber: number): Promise<CIStatusResult> => {
  const result = await runCommand('gh', ['pr', 'checks', String(prNumber)])
  const lines = result.stdout.split('\n').filter(Boolean)

  const checks: CheckResult[] = lines.map((line) => {
    const parts = line.split('\t')
    return {
      name: parts[0]?.trim() ?? '',
      status: parts[1]?.trim() ?? '',
      conclusion: parts[2]?.trim() ?? '',
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

/** Watch CI checks for a PR, blocking until complete or failure */
export const watchCI = async (prNumber: number): Promise<{ passing: boolean; output: string }> => {
  const result = await runCommand('gh', ['pr', 'checks', String(prNumber), '--watch', '--fail-fast'])
  return {
    passing: result.exitCode === 0,
    output: result.stdout || result.stderr,
  }
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

const parseRequiredPR = (args: string[]): number => {
  const idx = args.indexOf('--pr')
  if (idx === -1 || idx + 1 >= args.length) {
    throw new Error('Missing required argument: --pr')
  }
  const num = parseInt(args[idx + 1], 10)
  if (isNaN(num)) {
    throw new Error(`--pr must be a number, got: ${args[idx + 1]}`)
  }
  return num
}

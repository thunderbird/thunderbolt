import { spawn } from 'child_process'

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

/** Run a command and capture its output */
export const runCommand = (cmd: string, args: string[]): Promise<CommandResult> =>
  new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    proc.stdout.on('data', (d: Buffer) => stdout.push(d))
    proc.stderr.on('data', (d: Buffer) => stderr.push(d))
    proc.on('error', (err) => {
      resolve({ stdout: '', stderr: err.message, exitCode: 1 })
    })
    proc.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString().trim(),
        stderr: Buffer.concat(stderr).toString().trim(),
        exitCode: code ?? 1,
      })
    })
  })

/** Run a gh CLI command and return stdout, throwing on failure */
export const gh = async (args: string[]): Promise<string> => {
  const result = await runCommand('gh', args)
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr}`)
  }
  return result.stdout
}

/** Get the owner/repo string for the current repository */
export const getRepo = async (): Promise<string> =>
  gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])

/** Get the GraphQL node ID for a pull request */
export const getPRNodeId = async (prNumber: number): Promise<string> => {
  const repo = await getRepo()
  return gh(['api', `repos/${repo}/pulls/${prNumber}`, '--jq', '.node_id'])
}

/** Get the PR number for the current branch */
export const getPRNumber = async (): Promise<number> => {
  const result = await gh([
    'pr',
    'list',
    '--head',
    await getCurrentBranch(),
    '--json',
    'number',
    '--jq',
    '.[0].number',
  ])
  const num = parseInt(result, 10)
  if (isNaN(num)) {
    throw new Error('No PR found for the current branch')
  }
  return num
}

/** Get the current git branch name */
export const getCurrentBranch = async (): Promise<string> => {
  const result = await runCommand('git', ['branch', '--show-current'])
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get current branch: ${result.stderr}`)
  }
  return result.stdout
}

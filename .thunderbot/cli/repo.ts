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


/** Get the current git branch name */
export const getCurrentBranch = async (): Promise<string> => {
  const result = await runCommand('git', ['branch', '--show-current'])
  if (result.exitCode !== 0) {
    throw new Error(`Failed to get current branch: ${result.stderr}`)
  }
  return result.stdout
}

/** Parse a required argument by flag name from a CLI args array */
export const parseRequiredArg = (args: string[], flag: string, type: 'number' | 'string'): number | string => {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) {
    throw new Error(`Missing required argument: ${flag}`)
  }
  const raw = args[idx + 1]
  if (type === 'number') {
    const num = parseInt(raw, 10)
    if (isNaN(num)) {
      throw new Error(`${flag} must be a number, got: ${raw}`)
    }
    return num
  }
  return raw
}

/** Parse the --pr flag from args, throwing if missing or non-numeric */
export const parseRequiredPR = (args: string[]): number =>
  parseRequiredArg(args, '--pr', 'number') as number

/**
 * Write a GraphQL query to a temp file and execute it via gh api graphql.
 * This avoids the $id shell expansion issue that occurs with inline queries.
 */
export const runGraphQL = async (query: string, variables: Record<string, string>): Promise<string> => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('fs')
  const { join } = await import('path')
  const { tmpdir } = await import('os')

  const dir = mkdtempSync(join(tmpdir(), 'thunderbot-gql-'))
  const queryFile = join(dir, 'query.graphql')
  try {
    writeFileSync(queryFile, query)
    const args = ['api', 'graphql', '-F', `query=@${queryFile}`]
    for (const [key, value] of Object.entries(variables)) {
      args.push('-f', `${key}=${value}`)
    }
    return await gh(args)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Run a GraphQL query, check for errors, and return the data property */
export const runGraphQLJSON = async <T>(query: string, variables: Record<string, string>): Promise<T> => {
  const raw = await runGraphQL(query, variables)
  const response = JSON.parse(raw)
  if (response.errors?.length > 0) {
    throw new Error(`GraphQL query failed: ${JSON.stringify(response.errors)}`)
  }
  return response.data as T
}

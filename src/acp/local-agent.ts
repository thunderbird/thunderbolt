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
 * Inline Node.js script that bridges stdio to a child process.
 * Used to spawn binary agents through the `node` Tauri capability
 * since Tauri's shell:allow-spawn only permits named commands (node, uvx).
 *
 * Accepts the binary path as argv[1] and remaining args from argv[2+]
 * (node -e strips -e and the script from process.argv).
 * Pipes stdin/stdout for ACP communication and inherits stderr for diagnostics.
 */
const binaryBridgeScript = [
  'const{spawn}=require("child_process");',
  'const c=spawn(process.argv[1],process.argv.slice(2),{stdio:["pipe","pipe","inherit"]});',
  'process.stdin.pipe(c.stdin);',
  'c.stdout.pipe(process.stdout);',
  'c.on("exit",code=>process.exit(code??1));',
  'process.on("SIGTERM",()=>c.kill("SIGTERM"));',
].join('')

/**
 * Resolves the spawn command and args for an agent based on its distribution type.
 *
 * All installed agents are spawned via allowed Tauri shell capabilities (node, uvx).
 * The resolution uses distributionType when available, and falls back to heuristics
 * based on the command path (e.g. detecting node_modules/.bin in the path).
 */
const resolveSpawnCommand = (agentConfig: AgentConfig): { command: string; args: string[] } => {
  const command = agentConfig.command
  if (!command) {
    throw new Error(`Agent "${agentConfig.name}" has no command configured`)
  }

  const baseArgs = agentConfig.args ?? []
  const isAbsolutePath = command.startsWith('/')

  // NPX-installed agents: use node to run the installed script
  if (agentConfig.distributionType === 'npx' && agentConfig.installPath) {
    return { command: 'node', args: [command, ...baseArgs] }
  }

  // UVX-installed agents: use uvx to run the installed package
  if (agentConfig.distributionType === 'uvx' && agentConfig.packageName) {
    return { command: 'uvx', args: [agentConfig.packageName, ...baseArgs] }
  }

  // Binary agents: bridge through node since Tauri only allows named spawn commands
  if (agentConfig.distributionType === 'binary' && agentConfig.installPath) {
    return { command: 'node', args: ['-e', binaryBridgeScript, command, ...baseArgs] }
  }

  // ── Fallback heuristics when distributionType is missing ───────────────────
  // This handles agents installed before distributionType was tracked, or cases
  // where the field wasn't persisted (e.g. PowerSync column mapping issues).

  // Absolute path containing node_modules → likely an NPX-installed agent
  if (isAbsolutePath && command.includes('/node_modules/')) {
    return { command: 'node', args: [command, ...baseArgs] }
  }

  // Any other absolute path → use node bridge to spawn the binary
  if (isAbsolutePath) {
    return { command: 'node', args: ['-e', binaryBridgeScript, command, ...baseArgs] }
  }

  // Bare command name (no path) — bridge through node so child_process resolves it on PATH.
  // Direct spawn only works for commands in shell:allow-spawn (node, uvx).
  return { command: 'node', args: ['-e', binaryBridgeScript, command, ...baseArgs] }
}

/**
 * Spawn a local CLI agent and create an ACP connection to it.
 * Returns the stream for ClientSideConnection and a cleanup function.
 */
export const connectToLocalAgent = async ({
  agentConfig,
  spawner,
}: LocalAgentConnectionOptions): Promise<LocalAgentConnection> => {
  const { command, args } = resolveSpawnCommand(agentConfig)

  console.info(
    `Spawning agent "${agentConfig.name}": ${command} ${args.slice(0, 3).join(' ')}${args.length > 3 ? '...' : ''}`,
  )
  console.info(
    `  distributionType=${agentConfig.distributionType ?? 'undefined'} installPath=${agentConfig.installPath ?? 'undefined'} packageName=${agentConfig.packageName ?? 'undefined'}`,
  )

  const stderrChunks: string[] = []

  const handle = await spawner.spawn(command, args)
  const stream = createStdioStream(handle)

  // Capture stderr for diagnostics — logged on exit and included in timeout errors
  handle.onStderr?.((data) => {
    stderrChunks.push(data)
    console.warn(`Agent "${agentConfig.name}" stderr:`, data)
  })

  // Set up exit handler
  handle.onExit((code) => {
    const stderr = stderrChunks.join('')
    if (code !== 0 && stderr) {
      console.error(`Agent "${agentConfig.name}" exited with code ${code}:\n${stderr}`)
    } else {
      console.info(`Agent "${agentConfig.name}" exited with code ${code}`)
    }
  })

  const cleanup = async () => {
    await handle.kill()
  }

  return { stream, process: handle, cleanup }
}

// Export for testing
export { resolveSpawnCommand }

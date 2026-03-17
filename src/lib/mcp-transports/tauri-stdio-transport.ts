import { Command } from '@tauri-apps/plugin-shell'
import type { Child } from '@tauri-apps/plugin-shell'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/** Regex for validating stdio command names — no shell meta-characters */
const COMMAND_PATTERN = /^[a-zA-Z0-9._/-]+$/

/** Options for TauriStdioTransport */
type TauriStdioTransportOptions = {
  /** The command to execute (e.g. 'npx', 'uvx', 'node') */
  command: string
  /** Arguments to pass to the command */
  args?: string[]
  /** Environment variables to inject into the child process */
  env?: Record<string, string>
}

/**
 * Custom MCP transport that spawns a child process via Tauri's shell plugin
 * and communicates over stdin/stdout using newline-delimited JSON-RPC.
 *
 * This is necessary because the MCP SDK's StdioClientTransport uses Node.js
 * child_process.spawn() which does not work in a Tauri webview context.
 */
export class TauriStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private readonly options: TauriStdioTransportOptions
  private child: Child | null = null
  private lineBuffer = ''

  constructor(options: TauriStdioTransportOptions) {
    validateCommand(options.command)
    validateArgs(options.args)
    this.options = options
  }

  async start(): Promise<void> {
    const { command, args = [], env } = this.options

    const cmd = Command.create(command, args, env ? { env } : undefined)

    cmd.stdout.on('data', (chunk: string) => this.handleStdoutData(chunk))

    cmd.stderr.on('data', (chunk: string) => {
      this.onerror?.(new Error(`[stdio stderr] ${chunk}`))
    })

    cmd.on('close', () => {
      this.child = null
      this.onclose?.()
    })

    cmd.on('error', (message: string) => {
      this.onerror?.(new Error(`[stdio process error] ${message}`))
    })

    this.child = await cmd.spawn()
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.child) throw new Error('Transport not started')
    await this.child.write(JSON.stringify(message) + '\n')
  }

  async close(): Promise<void> {
    if (!this.child) return
    const child = this.child
    this.child = null
    await child.kill()
    this.onclose?.()
  }

  /** Buffers incoming stdout data, emitting complete JSON-RPC messages line by line. */
  private handleStdoutData(chunk: string): void {
    this.lineBuffer += chunk

    const lines = this.lineBuffer.split('\n')

    // All complete lines are all but the last element (which may be incomplete)
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim()
      if (!line) continue
      this.parseAndEmitMessage(line)
    }

    this.lineBuffer = lines[lines.length - 1]
  }

  private parseAndEmitMessage(line: string): void {
    try {
      const message = JSON.parse(line) as JSONRPCMessage
      this.onmessage?.(message)
    } catch {
      this.onerror?.(new Error(`Failed to parse JSON-RPC message from stdio: ${line}`))
    }
  }
}

/**
 * Validates that a stdio command contains only safe characters.
 * Rejects shell meta-characters to prevent injection.
 */
export const validateCommand = (command: string): void => {
  if (!COMMAND_PATTERN.test(command)) {
    throw new Error(
      `Invalid MCP stdio command "${command}": only alphanumeric characters, dots, underscores, hyphens, and forward slashes are allowed`,
    )
  }
}

/**
 * Validates that stdio args contain no null bytes, which could be used to
 * truncate argument strings in certain environments.
 */
export const validateArgs = (args?: string[]): void => {
  if (!args) return
  for (const arg of args) {
    if (arg.includes('\0')) {
      throw new Error('MCP stdio arguments must not contain null bytes')
    }
  }
}

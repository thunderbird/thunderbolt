import { describe, expect, test } from 'bun:test'
import { spawn } from 'child_process'
import { resolveSpawnCommand } from './local-agent'
import { createStdioStream } from './stdio-stream'
import type { AgentConfig } from './types'
import type { SubprocessHandle } from './stdio-stream'

/**
 * E2E tests that spawn real processes to verify the full spawn → stdio → ACP path.
 * These use Node.js child_process directly (not Tauri's Command.create) but verify
 * the same commands and args that the Tauri spawner would use.
 */

/** Spawn a real process using the same command/args that resolveSpawnCommand produces. */
const spawnReal = (command: string, args: string[]): SubprocessHandle => {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout!.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      child.stdout!.on('end', () => {
        try {
          controller.close()
        } catch {
          // Already closed
        }
      })
      child.on('error', (err) => {
        try {
          controller.error(err)
        } catch {
          // Already closed
        }
      })
    },
  })

  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise((resolve, reject) => {
        child.stdin!.write(chunk, (err) => (err ? reject(err) : resolve()))
      })
    },
    close() {
      child.stdin!.end()
    },
  })

  const stderrChunks: string[] = []
  child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()))

  return {
    stdin,
    stdout,
    kill: async () => {
      child.kill('SIGTERM')
    },
    onExit: (callback) => {
      child.on('exit', (code) => callback(code))
    },
    onStderr: (callback) => {
      child.stderr!.on('data', (chunk: Buffer) => callback(chunk.toString()))
    },
  }
}

/** Send a JSON-RPC message over the stream and read the response. */
const sendJsonRpc = async (
  handle: SubprocessHandle,
  message: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> => {
  const writer = handle.stdin.getWriter()
  const reader = handle.stdout.getReader()

  const payload = JSON.stringify(message) + '\n'
  await writer.write(new TextEncoder().encode(payload))
  writer.releaseLock()

  const decoder = new TextDecoder()
  let buffer = ''

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`No response within ${timeoutMs}ms`)), timeoutMs),
  )

  const read = async (): Promise<Record<string, unknown>> => {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        throw new Error('Stream ended before response')
      }
      buffer += decoder.decode(value, { stream: true })
      const newlineIdx = buffer.indexOf('\n')
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx)
        reader.releaseLock()
        return JSON.parse(line)
      }
    }
  }

  return Promise.race([read(), timeout])
}

describe('e2e: node bridge for binary agents', () => {
  test('node -e bridge script can spawn a child and pipe stdio', async () => {
    // Create a tiny "ACP agent" that echoes JSON-RPC responses
    const fakeAgentScript = `
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          try {
            const msg = JSON.parse(line);
            const response = { jsonrpc: '2.0', id: msg.id, result: { echo: msg.method } };
            process.stdout.write(JSON.stringify(response) + '\\n');
          } catch {}
        }
      });
    `

    // This simulates what resolveSpawnCommand produces for binary agents,
    // except the "binary" is itself a node script for testing purposes
    const config: AgentConfig = {
      id: 'test-binary-agent',
      name: 'Test Binary Agent',
      type: 'local',
      transport: 'stdio',
      command: 'node', // In real usage this would be a binary path
      args: ['-e', fakeAgentScript],
      distributionType: 'binary',
      installPath: '/fake/path',
      isSystem: false,
      enabled: true,
    }

    const { command, args } = resolveSpawnCommand(config)

    // The bridge script should be used
    expect(command).toBe('node')
    expect(args[0]).toBe('-e')
    // Bridge script is args[1]
    expect(args[1]).toContain('spawn')
    // Original command becomes args[2], original args follow
    // (node -e strips the -e and script from process.argv, so argv[1]=args[2], argv[2]=args[3], etc.)
    expect(args[2]).toBe('node')
    expect(args[3]).toBe('-e')
    expect(args[4]).toBe(fakeAgentScript)

    // Actually spawn and communicate
    const handle = spawnReal(command, args)

    const response = await sendJsonRpc(handle, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    })

    expect(response.jsonrpc).toBe('2.0')
    expect(response.id).toBe(1)
    expect((response.result as Record<string, unknown>).echo).toBe('initialize')

    await handle.kill()
  })

  test('node bridge forwards exit code from child', async () => {
    const exitScript = 'process.exit(42);'

    const handle = spawnReal('node', [
      '-e',
      [
        'const{spawn}=require("child_process");',
        'const c=spawn(process.argv[1],process.argv.slice(2),{stdio:["pipe","pipe","inherit"]});',
        'process.stdin.pipe(c.stdin);',
        'c.stdout.pipe(process.stdout);',
        'c.on("exit",code=>process.exit(code??1));',
        'process.on("SIGTERM",()=>c.kill("SIGTERM"));',
      ].join(''),
      'node',
      '-e',
      exitScript,
    ])

    const exitCode = await new Promise<number | null>((resolve) => {
      handle.onExit(resolve)
    })

    expect(exitCode).toBe(42)
  })

  test('node bridge handles child stderr without corrupting stdout', async () => {
    const agentScript = `
      process.stderr.write('debug info\\n');
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          try {
            const msg = JSON.parse(line);
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'ok' }) + '\\n');
          } catch {}
        }
      });
    `

    const config: AgentConfig = {
      id: 'test-stderr-agent',
      name: 'Stderr Agent',
      type: 'local',
      transport: 'stdio',
      command: 'node',
      args: ['-e', agentScript],
      distributionType: 'binary',
      installPath: '/fake/path',
      isSystem: false,
      enabled: true,
    }

    const { command, args } = resolveSpawnCommand(config)
    const handle = spawnReal(command, args)

    // Should still get clean JSON-RPC on stdout despite stderr output
    const response = await sendJsonRpc(handle, {
      jsonrpc: '2.0',
      id: 1,
      method: 'test',
      params: {},
    })

    expect(response.id).toBe(1)
    expect(response.result).toBe('ok')

    await handle.kill()
  })
})

describe('e2e: NPX agent spawn', () => {
  test('node can execute an agent script directly', async () => {
    const agentScript = `
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          try {
            const msg = JSON.parse(line);
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { method: msg.method } }) + '\\n');
          } catch {}
        }
      });
    `

    // Write the script to a temp file to simulate an NPX-installed agent
    const tmpDir = await import('os').then((os) => os.tmpdir())
    const scriptPath = `${tmpDir}/test-acp-agent-${Date.now()}.js`
    await Bun.write(scriptPath, agentScript)

    try {
      const config: AgentConfig = {
        id: 'test-npx-agent',
        name: 'Test NPX Agent',
        type: 'local',
        transport: 'stdio',
        command: scriptPath,
        args: [],
        distributionType: 'npx',
        installPath: tmpDir,
        isSystem: false,
        enabled: true,
      }

      const { command, args } = resolveSpawnCommand(config)

      expect(command).toBe('node')
      expect(args[0]).toBe(scriptPath)

      const handle = spawnReal(command, args)

      const response = await sendJsonRpc(handle, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      })

      expect(response.jsonrpc).toBe('2.0')
      expect(response.id).toBe(1)
      expect((response.result as Record<string, unknown>).method).toBe('initialize')

      await handle.kill()
    } finally {
      await import('fs/promises').then((fs) => fs.unlink(scriptPath).catch(() => {}))
    }
  })
})

describe('e2e: ndJsonStream integration', () => {
  test('createStdioStream produces a valid ACP stream from subprocess handle', async () => {
    const agentScript = `
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          try {
            const msg = JSON.parse(line);
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'connected' } }) + '\\n');
          } catch {}
        }
      });
    `

    const handle = spawnReal('node', ['-e', agentScript])
    const stream = createStdioStream(handle)

    // Write a JSON-RPC message via the stream's writable side
    const writer = stream.writable.getWriter()
    await writer.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    writer.releaseLock()

    // Read the response from the stream's readable side
    const reader = stream.readable.getReader()
    const { value } = await reader.read()
    reader.releaseLock()

    expect(value).toEqual({ jsonrpc: '2.0', id: 1, result: { status: 'connected' } })

    await handle.kill()
  })
})

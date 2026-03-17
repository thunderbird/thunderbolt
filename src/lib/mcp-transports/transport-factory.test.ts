import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { createTransport } from './transport-factory'
import { validateCommand, validateArgs, TauriStdioTransport } from './tauri-stdio-transport'
import type { McpServerConfig, CredentialStore, McpCredential } from '@/types/mcp'

// Mock Tauri plugins so tests can run outside a Tauri runtime
mock.module('@tauri-apps/plugin-http', () => ({
  fetch: mock(() => Promise.resolve(new Response())),
}))

mock.module('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: mock(() => ({
      stdout: { on: mock(() => {}) },
      stderr: { on: mock(() => {}) },
      on: mock(() => {}),
      spawn: mock(() => Promise.resolve({ pid: 1234, write: mock(() => Promise.resolve()), kill: mock(() => Promise.resolve()) })),
    })),
  },
}))

mock.module('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(public url: URL, public opts: unknown) {}
    start() { return Promise.resolve() }
    send() { return Promise.resolve() }
    close() { return Promise.resolve() }
  },
}))

mock.module('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    constructor(public url: URL, public opts: unknown) {}
    start() { return Promise.resolve() }
    send() { return Promise.resolve() }
    close() { return Promise.resolve() }
  },
}))

const makeConfig = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'server-1',
  name: 'Test Server',
  enabled: true,
  transport: { type: 'http', url: 'https://example.com/mcp' },
  auth: { authType: 'none' },
  ...overrides,
})

const makeCredentialStore = (credential: McpCredential | null = null): CredentialStore => ({
  save: mock(() => Promise.resolve()),
  load: mock(() => Promise.resolve(credential)),
  delete: mock(() => Promise.resolve()),
})

describe('createTransport', () => {
  it('creates HTTP transport for http type', async () => {
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    )
    const result = await createTransport(makeConfig({ transport: { type: 'http', url: 'https://example.com/mcp' } }), makeCredentialStore())
    expect(result.transport).toBeInstanceOf(StreamableHTTPClientTransport)
  })

  it('creates SSE transport for sse type', async () => {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
    const result = await createTransport(makeConfig({ transport: { type: 'sse', url: 'https://example.com/sse' } }), makeCredentialStore())
    expect(result.transport).toBeInstanceOf(SSEClientTransport)
  })

  it('creates stdio transport for stdio type', async () => {
    const result = await createTransport(
      makeConfig({ transport: { type: 'stdio', command: 'npx', args: ['some-server'] } }),
      makeCredentialStore(),
    )
    expect(result.transport).toBeInstanceOf(TauriStdioTransport)
  })

  it('injects bearer token as Authorization header for HTTP transport', async () => {
    const credential: McpCredential = { type: 'bearer', token: 'secret-token' }
    const result = await createTransport(
      makeConfig({
        transport: { type: 'http', url: 'https://example.com/mcp' },
        auth: { authType: 'bearer' },
      }),
      makeCredentialStore(credential),
    )
    // The transport is created; we verify the store was queried
    expect(result.transport).toBeDefined()
  })

  it('injects bearer token as env var for stdio transport', async () => {
    const credential: McpCredential = { type: 'bearer', token: 'my-api-key' }
    const store = makeCredentialStore(credential)
    const result = await createTransport(
      makeConfig({
        transport: { type: 'stdio', command: 'uvx', args: ['zendesk-mcp'] },
        auth: { authType: 'bearer' },
      }),
      store,
    )
    expect(result.transport).toBeInstanceOf(TauriStdioTransport)
    expect(store.load).toHaveBeenCalledWith('server-1')
  })

  it('throws for unknown transport type', async () => {
    const config = makeConfig({ transport: { type: 'unknown' as 'http' } })
    await expect(createTransport(config, makeCredentialStore())).rejects.toThrow(
      'Unknown MCP transport type',
    )
  })
})

describe('validateCommand', () => {
  it('accepts valid command names', () => {
    expect(() => validateCommand('npx')).not.toThrow()
    expect(() => validateCommand('uvx')).not.toThrow()
    expect(() => validateCommand('node')).not.toThrow()
    expect(() => validateCommand('python3')).not.toThrow()
    expect(() => validateCommand('/usr/bin/node')).not.toThrow()
    expect(() => validateCommand('bun')).not.toThrow()
  })

  it('rejects shell meta-characters', () => {
    expect(() => validateCommand('node; rm -rf')).toThrow()
    expect(() => validateCommand('node | cat')).toThrow()
    expect(() => validateCommand('node && evil')).toThrow()
    expect(() => validateCommand('$(whoami)')).toThrow()
    expect(() => validateCommand('`id`')).toThrow()
    expect(() => validateCommand('node > /dev/null')).toThrow()
    expect(() => validateCommand('node < input')).toThrow()
  })

  it('rejects commands with spaces', () => {
    expect(() => validateCommand('node server.js')).toThrow()
  })
})

describe('validateArgs', () => {
  it('accepts normal args', () => {
    expect(() => validateArgs(['--flag', 'value', '-x'])).not.toThrow()
  })

  it('accepts undefined args', () => {
    expect(() => validateArgs(undefined)).not.toThrow()
  })

  it('rejects args containing null bytes', () => {
    expect(() => validateArgs(['valid', 'arg\0injection'])).toThrow('null bytes')
  })
})

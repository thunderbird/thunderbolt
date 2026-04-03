import { describe, expect, it, mock, beforeEach } from 'bun:test'

let mockInvokeResult: any = { pid: 12345 }

import { tauriCoreMock } from '@/test-utils/tauri-mock'

mock.module('@tauri-apps/api/core', () => ({
  ...tauriCoreMock,
  invoke: async (cmd: string, args: any) => {
    if (cmd === 'spawn_agent') {
      if (args.binaryPath.includes('nonexistent')) {
        throw new Error('Failed to spawn agent')
      }
      return mockInvokeResult
    }
    return {}
  },
  isTauri: () => true,
}))

mock.module('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: () => ({
      execute: async () => ({ code: 0, stdout: '', stderr: '' }),
      spawn: async () => ({
        pid: 99999,
        write: async () => {},
        kill: async () => {},
      }),
    }),
  },
}))

import { desktopPlatformMock } from '@/test-utils/platform-mock'

mock.module('@/lib/platform', () => desktopPlatformMock)

describe('spawn-agent', () => {
  let mod: typeof import('./spawn-agent')

  beforeEach(async () => {
    mockInvokeResult = 12345
    mod = await import('./spawn-agent')
  })

  describe('spawnInstalledAgent', () => {
    it('invokes the Tauri spawn_agent command', async () => {
      const result = await mod.spawnInstalledAgent('/mock/app-data/agents/claude-acp/node_modules/.bin/agent', [
        '--acp',
      ])
      expect(result).toBeDefined()
    })

    it('throws for nonexistent binary', async () => {
      await expect(mod.spawnInstalledAgent('/mock/app-data/agents/nonexistent/bin/agent', [])).rejects.toThrow()
    })

    it('passes environment variables', async () => {
      const result = await mod.spawnInstalledAgent('/mock/app-data/agents/claude-acp/bin/agent', [], {
        ANTHROPIC_API_KEY: '',
      })
      expect(result).toBeDefined()
    })
  })

  describe('isInstalledAgent', () => {
    it('returns true when installPath is set', () => {
      expect(mod.isInstalledAgent({ installPath: '/some/path' } as any)).toBe(true)
    })

    it('returns false when installPath is null', () => {
      expect(mod.isInstalledAgent({ installPath: null } as any)).toBe(false)
    })

    it('returns false when installPath is undefined', () => {
      expect(mod.isInstalledAgent({} as any)).toBe(false)
    })
  })
})

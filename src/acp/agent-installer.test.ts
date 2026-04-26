import { describe, expect, it, mock, beforeEach } from 'bun:test'

// ── Mocks ─────────────────────────────────────────────────────────────────────

let mockExecuteResult = { code: 0, stdout: '', stderr: '' }
let mockFsExists = false
let mockAppDataDir = '/mock/app-data'
let mockDownloadResponse: { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> } = {
  ok: true,
  arrayBuffer: async () => new ArrayBuffer(0),
}

mock.module('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: (_name: string, _args: string[]) => ({
      execute: async () => mockExecuteResult,
    }),
  },
}))

mock.module('@tauri-apps/api/path', () => ({
  appDataDir: async () => mockAppDataDir,
}))

mock.module('@tauri-apps/plugin-fs', () => ({
  exists: async () => mockFsExists,
  mkdir: async () => {},
  remove: async () => {},
  writeFile: async () => {},
}))

mock.module('@tauri-apps/plugin-http', () => ({
  fetch: async () => mockDownloadResponse,
}))

import { tauriCoreMock } from '@/test-utils/tauri-mock'

mock.module('@tauri-apps/api/core', () => ({
  ...tauriCoreMock,
  invoke: async () => ({}),
  isTauri: () => true,
}))

import { desktopPlatformMock } from '@/test-utils/platform-mock'

mock.module('@/lib/platform', () => desktopPlatformMock)

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('agent-installer', () => {
  let installer: typeof import('./agent-installer')

  beforeEach(async () => {
    mockExecuteResult = { code: 0, stdout: '', stderr: '' }
    mockFsExists = false
    mockAppDataDir = '/mock/app-data'
    mockDownloadResponse = {
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    }
    installer = await import('./agent-installer')
  })

  describe('getAgentsDir', () => {
    it('returns $APPDATA/agents/', async () => {
      const dir = await installer.getAgentsDir()
      expect(dir).toBe('/mock/app-data/agents')
    })
  })

  describe('getAgentInstallPath', () => {
    it('returns correct subdirectory for registryId', async () => {
      const path = await installer.getAgentInstallPath('claude-acp')
      expect(path).toBe('/mock/app-data/agents/claude-acp')
    })

    it('handles special characters in registryId', async () => {
      const path = await installer.getAgentInstallPath('my-agent-v2')
      expect(path).toBe('/mock/app-data/agents/my-agent-v2')
    })
  })

  describe('checkRuntimeAvailable', () => {
    it('returns true for npx when npm is on PATH', async () => {
      mockExecuteResult = { code: 0, stdout: '/usr/local/bin/npm', stderr: '' }
      const result = await installer.checkRuntimeAvailable('npx')
      expect(result).toBe(true)
    })

    it('returns false for npx when npm is missing', async () => {
      mockExecuteResult = { code: 1, stdout: '', stderr: 'not found' }
      const result = await installer.checkRuntimeAvailable('npx')
      expect(result).toBe(false)
    })

    it('always returns true for binary (no runtime needed)', async () => {
      const result = await installer.checkRuntimeAvailable('binary')
      expect(result).toBe(true)
    })

    it('returns true for uvx when uv is on PATH', async () => {
      mockExecuteResult = { code: 0, stdout: '/usr/local/bin/uv', stderr: '' }
      const result = await installer.checkRuntimeAvailable('uvx')
      expect(result).toBe(true)
    })

    it('returns false for uvx when uv is missing', async () => {
      mockExecuteResult = { code: 1, stdout: '', stderr: 'not found' }
      const result = await installer.checkRuntimeAvailable('uvx')
      expect(result).toBe(false)
    })
  })

  describe('installNpxAgent', () => {
    it('returns installed binary path on success', async () => {
      mockExecuteResult = { code: 0, stdout: '', stderr: '' }
      mockFsExists = true

      const result = await installer.installNpxAgent({
        registryId: 'claude-acp',
        packageName: '@agentclientprotocol/claude-agent-acp@0.24.2',
      })

      expect(result.installPath).toBe('/mock/app-data/agents/claude-acp')
      expect(result.command).toContain('claude-agent-acp')
    })

    it('throws if npm install fails', async () => {
      mockExecuteResult = { code: 1, stdout: '', stderr: 'npm ERR! 404 Not Found' }

      await expect(
        installer.installNpxAgent({
          registryId: 'nonexistent',
          packageName: '@test/nonexistent@1.0.0',
        }),
      ).rejects.toThrow()
    })

    it('throws if npm is not available', async () => {
      // First call: `which npm` fails
      mockExecuteResult = { code: 1, stdout: '', stderr: 'not found' }

      await expect(
        installer.installNpxAgent({
          registryId: 'claude-acp',
          packageName: '@test/agent@1.0.0',
          checkRuntime: true,
        }),
      ).rejects.toThrow(/Node\.js/)
    })
  })

  describe('installBinaryAgent', () => {
    it('returns installed binary path on success', async () => {
      mockDownloadResponse = {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(10),
      }
      mockExecuteResult = { code: 0, stdout: '', stderr: '' }
      mockFsExists = true

      const result = await installer.installBinaryAgent({
        registryId: 'goose',
        archiveUrl: 'https://example.com/goose.tar.gz',
        cmd: './goose',
      })

      expect(result.installPath).toBe('/mock/app-data/agents/goose')
      expect(result.command).toContain('goose')
    })

    it('throws on download failure', async () => {
      mockDownloadResponse = {
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0),
      }

      await expect(
        installer.installBinaryAgent({
          registryId: 'goose',
          archiveUrl: 'https://example.com/goose.tar.gz',
          cmd: './goose',
        }),
      ).rejects.toThrow(/download/i)
    })
  })

  describe('installUvxAgent', () => {
    it('returns installed info on success', async () => {
      mockExecuteResult = { code: 0, stdout: '', stderr: '' }
      mockFsExists = true

      const result = await installer.installUvxAgent({
        registryId: 'fast-agent',
        packageName: 'fast-agent@0.6.10',
      })

      expect(result.installPath).toBe('/mock/app-data/agents/fast-agent')
    })

    it('throws if uv is not available', async () => {
      mockExecuteResult = { code: 1, stdout: '', stderr: 'not found' }

      await expect(
        installer.installUvxAgent({
          registryId: 'fast-agent',
          packageName: 'fast-agent@0.6.10',
          checkRuntime: true,
        }),
      ).rejects.toThrow(/uv/)
    })
  })

  describe('uninstallAgent', () => {
    it('removes install directory', async () => {
      mockFsExists = true
      await expect(installer.uninstallAgent('claude-acp')).resolves.toBeUndefined()
    })

    it('no-ops if directory does not exist', async () => {
      mockFsExists = false
      await expect(installer.uninstallAgent('nonexistent')).resolves.toBeUndefined()
    })
  })

  describe('isAgentInstalled', () => {
    it('returns true when install directory exists', async () => {
      mockFsExists = true
      const result = await installer.isAgentInstalled('claude-acp')
      expect(result).toBe(true)
    })

    it('returns false when directory is missing', async () => {
      mockFsExists = false
      const result = await installer.isAgentInstalled('nonexistent')
      expect(result).toBe(false)
    })
  })
})

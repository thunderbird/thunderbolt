/**
 * Complete default mock for `@tauri-apps/api/core`.
 *
 * bun's `mock.module` replaces the entire module, so partial mocks
 * poison the module cache for any test that runs afterward.
 *
 * Usage:
 *   import { tauriCoreMock } from '@/test-utils/tauri-mock'
 *   mock.module('@tauri-apps/api/core', () => ({ ...tauriCoreMock, invoke: myMockInvoke }))
 */

class MockChannel {
  onmessage = () => {}
}

class MockResource {
  rid = 0
  async close() {}
}

class MockPluginListener {
  async unregister() {}
}

export const tauriCoreMock = {
  Channel: MockChannel,
  PluginListener: MockPluginListener,
  Resource: MockResource,
  SERIALIZE_TO_IPC_FN: Symbol('SERIALIZE_TO_IPC_FN'),
  addPluginListener: async () => new MockPluginListener(),
  checkPermissions: async () => ({}),
  convertFileSrc: (path: string) => path,
  invoke: async () => ({}),
  isTauri: () => false,
  requestPermissions: async () => ({}),
  transformCallback: () => 0,
}

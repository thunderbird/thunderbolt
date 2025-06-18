import { vi } from 'vitest'

console.log('Setting up test environment...')

// Mock Tauri window object
const mockInvoke = vi.fn().mockImplementation(async (cmd: string) => {
  if (cmd === 'plugin:sql|load') {
    return { success: true }
  }
  return []
})

// Create a minimal window mock
const windowMock = {
  __TAURI_INTERNALS__: {
    invoke: mockInvoke,
  },
}

// Mock SQLocal
const mockSQLMethod = vi.fn().mockImplementation(async (strings: TemplateStringsArray, ..._values: any[]) => {
  const sql = strings.join('?')
  if (sql.toLowerCase().includes('select')) {
    return [{ key: 'test_key', value: 'test_value' }]
  }
  return []
})

const mockSQLDriver = {
  sql: mockSQLMethod,
}

// Set up the mocks
vi.mock('sqlocal/drizzle', () => ({
  SQLocalDrizzle: class {
    constructor(_dbName: string) {
      return {
        driver: mockSQLDriver,
      }
    }
  },
}))

vi.mock('@/lib/libsql', () => ({
  default: {
    load: vi.fn().mockResolvedValue({
      select: vi.fn().mockResolvedValue([{ key: 'test_key', value: 'test_value' }]),
      execute: vi.fn().mockResolvedValue([]),
    }),
  },
}))

// Set up global mocks
Object.defineProperty(global, 'window', {
  value: windowMock,
  writable: true,
})

console.log('Test environment setup complete')

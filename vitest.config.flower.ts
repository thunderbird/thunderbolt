import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['flower/**/*.test.ts'],
    exclude: ['node_modules/**/*'],
    testTimeout: 5000,
    hookTimeout: 5000,
    teardownTimeout: 5000,
    silent: false,
    reporters: ['default'],
    coverage: {
      enabled: false,
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
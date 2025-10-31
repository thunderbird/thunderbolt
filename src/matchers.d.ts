import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

declare module 'bun:test' {
  interface Matchers<T> extends TestingLibraryMatchers<string, T> {}
  interface AsymmetricMatchers extends TestingLibraryMatchers {}
}

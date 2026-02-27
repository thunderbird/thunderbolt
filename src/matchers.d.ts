import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

declare module 'bun:test' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Matchers<T> extends TestingLibraryMatchers<string, T> {
    toBeNullOrUndefined(): void
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface AsymmetricMatchers extends TestingLibraryMatchers {}
}

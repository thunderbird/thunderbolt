declare module 'bun:test' {
  interface Matchers<T> {
    toBeNullOrUndefined(): void
  }
}

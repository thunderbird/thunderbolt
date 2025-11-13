/**
 * Check if the code is running in a test environment
 */
export const isTestEnv = (): boolean => {
  return typeof Bun !== 'undefined' && Bun.env.NODE_ENV === 'test'
}

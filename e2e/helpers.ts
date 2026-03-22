import type { Page } from '@playwright/test'

/**
 * Navigate to new chat page and wait for full render.
 */
export const goToNewChat = async (page: Page) => {
  await page.goto('/chats/new')
  // Wait for the chat UI to fully initialize (DB seeding, store hydration)
  await page.waitForTimeout(3000)
}

/**
 * Clear browser storage to ensure a fresh state.
 * Use in beforeEach when tests depend on clean DB state.
 */
export const clearBrowserStorage = async (page: Page) => {
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  // Clearing IndexedDB is harder — using fresh contexts is better
}

/**
 * Collect uncaught JS errors, filtering Tauri-specific noise.
 */
export const collectPageErrors = (page: Page): string[] => {
  const errors: string[] = []
  page.on('pageerror', (error) => {
    if (
      !error.message.includes('__TAURI__') &&
      !error.message.includes('tauri') &&
      !error.message.includes('window.__TAURI_INTERNALS__') &&
      !error.message.includes('convertFileSrc')
    ) {
      errors.push(error.message)
    }
  })
  return errors
}

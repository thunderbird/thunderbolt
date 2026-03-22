import type { Page } from '@playwright/test'

/**
 * Navigate to new chat page and wait for full render.
 */
export const goToNewChat = async (page: Page) => {
  await page.goto('/chats/new')
  // Wait for the agent selector in the header to appear (proves DB is initialized)
  await page.waitForTimeout(3000)
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

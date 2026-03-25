import { expect, type Page } from '@playwright/test'

/**
 * Dismiss the onboarding wizard if it appears.
 * The dialog blocks all pointer events with a z-50 overlay.
 */
export const dismissOnboarding = async (page: Page) => {
  try {
    const continueButton = page.getByRole('button', { name: 'Continue' })
    await expect(continueButton).toBeVisible({ timeout: 4000 })

    // Step 1: agree to privacy and continue
    const checkbox = page.locator('[role="checkbox"]').first()
    if (await checkbox.isVisible()) {
      await checkbox.click()
    }
    await continueButton.click()
    await page.waitForTimeout(300)

    // Steps 2-4: skip through them
    for (let i = 0; i < 3; i++) {
      const skipButton = page.getByRole('button', { name: 'Skip' })
      try {
        await expect(skipButton).toBeVisible({ timeout: 2000 })
        await skipButton.click()
        await page.waitForTimeout(300)
      } catch {
        break
      }
    }

    // Step 5: finish onboarding
    const startButton = page.getByRole('button', { name: 'Start Using Thunderbolt' })
    try {
      await expect(startButton).toBeVisible({ timeout: 2000 })
      await startButton.click()
      await page.waitForTimeout(500)
    } catch {
      // May have already closed
    }
  } catch {
    // No onboarding dialog — already completed or skipped
  }
}

/**
 * Navigate to the app root, let the OIDC flow complete naturally through
 * the mock OIDC server, dismiss onboarding if needed, and wait for the
 * authenticated chat UI to render.
 *
 * The flow: / → AuthGate → /oidc-redirect → POST sign-in → mock IdP /authorize
 * (auto-approves) → backend callback → token exchange → session → app
 */
export const loginViaOidc = async (page: Page) => {
  await page.goto('/')

  // Wait for the page to settle — either onboarding or chat UI
  await page.waitForTimeout(3000)
  await dismissOnboarding(page)

  // Wait for the OIDC flow to complete and land on the chat page
  const textarea = page.locator('textarea')
  await expect(textarea).toBeVisible({ timeout: 30_000 })
}

/**
 * Clear browser storage to ensure a fresh state.
 */
export const clearBrowserStorage = async (page: Page) => {
  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
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

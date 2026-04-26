import { expect, type Page } from '@playwright/test'

/**
 * Navigate to the app root, let the OIDC flow complete naturally through
 * the mock OIDC server, and wait for the authenticated chat UI to render.
 *
 * Onboarding is disabled via VITE_SKIP_ONBOARDING env var in playwright.config.ts.
 *
 * The flow: / -> AuthGate -> /oidc-redirect -> POST sign-in -> mock IdP /authorize
 * (auto-approves) -> backend callback -> token exchange -> session -> app
 */
export const loginViaOidc = async (page: Page) => {
  await page.goto('/')

  // Wait for the OIDC flow to complete and land on the chat page
  const textarea = page.locator('textarea')
  await expect(textarea).toBeVisible({ timeout: 30_000 })
}

/**
 * Navigate to new chat page and wait for the chat UI to fully render.
 * Completes onboarding if the dialog appears (it blocks all pointer events).
 * Asserts that critical elements are visible — fails fast if the page is blank.
 */
export const goToNewChat = async (page: Page) => {
  await page.goto('/chats/new')

  // The OnboardingDialog opens on fresh sessions with a fixed z-50 overlay
  // that blocks all click() actions. Wait briefly to see if it appears,
  // then dismiss it by clicking through the steps.
  try {
    const continueButton = page.getByRole('button', { name: 'Continue' })
    await expect(continueButton).toBeVisible({ timeout: 4000 })

    // Onboarding is open. Step 1: agree to privacy and continue
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
    // No onboarding dialog — VITE_SKIP_ONBOARDING is set or already completed
  }

  // Wait for the chat UI to hydrate — these are the minimum elements that prove the page rendered.
  // If any of these fail, the chat page is broken (blank screen, hydration hang, etc.)
  const textarea = page.locator('textarea')
  await expect(textarea).toBeVisible({ timeout: 15000 })

  const header = page.locator('header')
  await expect(header).toBeVisible({ timeout: 5000 })
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

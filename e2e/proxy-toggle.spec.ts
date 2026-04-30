import { test, expect } from '@playwright/test'
import { loginViaOidc, collectPageErrors } from './helpers'

test('web shows proxy toggle disabled with CORS tooltip', async ({ page }) => {
  const errors = collectPageErrors(page)

  await loginViaOidc(page)
  await page.goto('/settings/preferences')

  // Section heading is visible
  await expect(page.getByRole('heading', { name: 'Network' })).toBeVisible({ timeout: 10_000 })

  // The Switch role is present and disabled (Radix Switch sets role=switch + aria-disabled)
  const proxySwitch = page.getByRole('switch', { name: /cloud proxy/i }).first()
  await expect(proxySwitch).toBeVisible()
  await expect(proxySwitch).toBeDisabled()
  await expect(proxySwitch).toHaveAttribute('aria-checked', 'true')

  // Hover the wrapping span — Radix Tooltip should reveal the literal message
  const wrappingSpan = page.locator('span[aria-label="Cloud proxy is required in the web app"]')
  await wrappingSpan.hover()
  await expect(page.getByRole('tooltip')).toContainText(
    'Proxying is required in the web app to bypass browser CORS restrictions.',
    { timeout: 5_000 },
  )

  expect(errors).toHaveLength(0)
})

test('proxy_enabled localStorage persists across contexts', async ({ browser }) => {
  // Context A: log in, write the flag, capture storageState.
  const ctxA = await browser.newContext()
  const pageA = await ctxA.newPage()
  await loginViaOidc(pageA)
  await pageA.goto('/settings/preferences')
  await expect(pageA.getByRole('heading', { name: 'Network' })).toBeVisible({ timeout: 10_000 })

  // Set the flag directly — the web UI keeps the toggle disabled, so we round-trip via localStorage.
  // This is the documented persistence contract: the helper reads from this key, regardless of how it got there.
  await pageA.evaluate(() => localStorage.setItem('proxy_enabled', 'true'))
  const stored = await pageA.evaluate(() => localStorage.getItem('proxy_enabled'))
  expect(stored).toBe('true')

  // Persist the entire context (cookies + localStorage per origin).
  const stateFile = test.info().outputPath('storage-state.json')
  await ctxA.storageState({ path: stateFile })
  await ctxA.close()

  // Context B: hydrate from saved state, navigate, verify localStorage survived.
  const ctxB = await browser.newContext({ storageState: stateFile })
  const pageB = await ctxB.newPage()
  // We need to be on the app origin for localStorage to be readable.
  await pageB.goto('/settings/preferences')
  const restored = await pageB.evaluate(() => localStorage.getItem('proxy_enabled'))
  expect(restored).toBe('true')
  await ctxB.close()
})

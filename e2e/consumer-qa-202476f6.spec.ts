import { test, expect } from './test'
import { enterEmailCode } from './helpers'
import { layoutProblems } from '../.github/qa/layout'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

test('login code textbox has an accessible name', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Email' }).fill(`qa-c2-${Date.now()}@thunderbolt.test`)
  await page.getByRole('textbox', { name: 'Email' }).press('Enter')
  await expect(page.getByText('Check your email')).toBeVisible()
  await page.waitForTimeout(1000)
  await test.step('bug check', async () => {
    expect(await layoutProblems(page)).toEqual([])
  })
})

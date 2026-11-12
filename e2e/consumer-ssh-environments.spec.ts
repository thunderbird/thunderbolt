/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from './test'
import { loginViaEmailCode } from './helpers'
import { importBackup } from './import-backup'

test.use({ viewport: { width: 1280, height: 900 } })

test('web explains SSH availability without showing connection or credential controls', async ({ page }) => {
  await loginViaEmailCode(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Environments', exact: true }).click()
  await expect(page).toHaveURL('/settings/environments')
  await expect(page.getByRole('heading', { name: 'Environments', exact: true })).toBeVisible()
  await expect(page.getByText('SSH requires the desktop app', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add SSH environment', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)
  await page.goBack()
  await page.getByRole('button', { name: 'Agent location', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Manage SSH environments' })).toHaveCount(0)
})

test('a synced SSH project on web keeps its fixed identity and cannot fall back to the sandbox', async ({ page }) => {
  const email = await loginViaEmailCode(page)
  const projectId = crypto.randomUUID()
  const sandboxProjectId = crypto.randomUUID()
  const threadId = crypto.randomUUID()
  const environmentId = crypto.randomUUID()
  await importBackup(page, {
    format: 'thunderbolt-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    user: { id: 'ssh-project-fixture', email },
    tables: {
      projects: [
        { id: projectId, name: 'Remote project' },
        { id: sandboxProjectId, name: 'Sandbox project' },
      ],
      chat_threads: [{ id: threadId, title: 'Remote work', projectId }],
      settings: [
        {
          key: `project-execution:${projectId}`,
          value: JSON.stringify({ version: 1, location: 'ssh', environmentId }),
        },
      ],
    },
  })
  await page.goto(`/chats/${threadId}`)
  const projectRow = page.locator(`button[aria-controls="project-chats-${projectId}"]`)
  await expect(projectRow.getByRole('status', { name: 'SSH environment unavailable', exact: true })).toBeVisible()
  await expect(projectRow.getByRole('status', { name: 'SSH environment unavailable', exact: true })).toHaveAttribute(
    'title',
    'SSH environments require the desktop app.',
  )
  await expect(
    page.locator(`button[aria-controls="project-chats-${sandboxProjectId}"]`).getByRole('status'),
  ).toHaveCount(0)

  const projectSelector = page.locator('[title="In project: Remote project"]')
  await expect(projectSelector.getByRole('status', { name: 'SSH environment unavailable', exact: true })).toBeVisible()
  await projectSelector.click()
  const picker = page.locator('[data-slot="popover-content"]')
  await expect(
    picker
      .getByRole('button')
      .filter({ hasText: /^Remote project$/ })
      .getByRole('status'),
  ).toHaveAttribute('aria-label', 'SSH environment unavailable')
  await expect(picker.getByRole('button', { name: 'Sandbox project', exact: true }).getByRole('status')).toHaveCount(0)
  await picker.getByRole('button', { name: 'Configure Remote project', exact: true }).click()
  const projectSettings = page.getByRole('dialog', { name: 'Project settings', exact: true })
  await expect(projectSettings.getByLabel('Project environment', { exact: true })).toContainText(
    'SSH environment unavailable',
  )
  await expect(projectSettings.getByRole('status', { name: 'SSH environment unavailable', exact: true })).toBeVisible()
  await expect(projectSettings.getByRole('button', { name: 'Project environment', exact: true })).toHaveCount(0)
  await projectSettings.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(projectSettings).toHaveCount(0)
  await expect(picker).toHaveCount(0)

  await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click()
  const projectsMenu = page
    .getByRole('button', { name: 'Projects', exact: true })
    .and(page.locator('[data-slot="dropdown-menu-trigger"]'))
  await projectsMenu.click()
  await expect(projectsMenu).toHaveAttribute('aria-expanded', 'true')
  await expect(
    page
      .getByRole('menuitem')
      .filter({ hasText: /^Remote project$/ })
      .getByRole('status', { name: 'SSH environment unavailable' }),
  ).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Sandbox project', exact: true }).getByRole('status')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click()

  await page.getByRole('button', { name: 'Agent location', exact: true }).click()
  await expect(page.getByText('Set when this project was created', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitem').filter({ hasText: 'SSH environment' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await expect(page.getByRole('menuitem').filter({ hasText: 'Local sandbox' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Agent access', exact: true })).toBeDisabled()
  await expect(page.getByText('Open this project in the desktop app to run its agent.', { exact: true })).toBeVisible()
})

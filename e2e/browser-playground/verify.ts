/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { getChromeLaunchOptions } from '../../scripts/chrome'
import { startPlayground } from './server'

const server = startPlayground(0)
const browser = await chromium.launch(getChromeLaunchOptions())
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
const url = (path: string) => new URL(path, server.url).href

try {
  await page.goto(url('/'))
  assert.equal(await page.locator('.card').count(), 3)
  await page.getByRole('link', { name: /Open Minesweeper/ }).click()
  await page.locator('#mine-r1-c1').click()
  assert.equal(await page.locator('#mine-r1-c1').isDisabled(), true)
  assert(Number(await page.locator('#safe-left').textContent()) < 71)
  assert.equal(await page.locator('.mine').count(), 0, 'The first reveal must be safe')
  const initialBoard = await page.locator('.mine-cell').evaluateAll((cells) => cells.map((cell) => cell.textContent))
  const hidden = page.locator('.mine-cell:enabled').first()
  await hidden.click({ button: 'right' })
  assert.match((await hidden.getAttribute('aria-label')) ?? '', /flagged/)
  assert.equal(await page.locator('#mines-left').textContent(), '9')
  await hidden.press('f')
  assert.equal(await page.locator('#mines-left').textContent(), '10')
  await page.getByRole('button', { name: 'New game' }).click()
  await page.locator('#mine-r1-c1').click()
  assert.deepEqual(
    await page.locator('.mine-cell').evaluateAll((cells) => cells.map((cell) => cell.textContent)),
    initialBoard,
  )
  // Seed 42, first reveal r1c1 has a mine at r1c8. Pin a known reproducible loss.
  await page.locator('#mine-r1-c8').click()
  assert.match((await page.locator('#game-status').textContent()) ?? '', /found a mine/)
  assert.equal(await page.locator('.mine').count(), 10)
  // A loss reveals the layout; replay that same board to exercise the win condition.
  const mineIds = new Set(await page.locator('.mine').evaluateAll((cells) => cells.map((cell) => cell.id)))
  await page.getByRole('button', { name: 'New game' }).click()
  await page.locator('#mine-r1-c1').click()
  for (const cell of await page.locator('.mine-cell').all()) {
    if (!mineIds.has((await cell.getAttribute('id'))!) && (await cell.isEnabled())) {
      await cell.click()
    }
  }
  assert.match((await page.locator('#game-status').textContent()) ?? '', /you win/)
  process.stdout.write('PASS Minesweeper: safe start, flags, seeded reset, loss, win\n')

  await page.goto(url('/sudoku.html'))
  await page.locator('#sudoku-r1-c3').fill('9')
  await page.getByRole('button', { name: 'Check progress' }).click()
  assert.equal(await page.locator('#sudoku-r1-c3').getAttribute('aria-invalid'), 'true')
  await page.locator('#sudoku-r1-c3').fill('4')
  await page.locator('#sudoku-r1-c3').press('ArrowRight')
  assert.equal(await page.locator('#sudoku-r1-c4').evaluate((cell) => cell === document.activeElement), true)
  await page.getByRole('button', { name: 'Enter 6', exact: true }).click()
  assert.equal(await page.locator('#sudoku-r1-c4').inputValue(), '6')
  await page.getByRole('button', { name: 'Erase cell' }).click()
  assert.equal(await page.locator('#sudoku-r1-c4').inputValue(), '')
  await page.getByRole('button', { name: 'Check progress' }).click()
  assert.match((await page.locator('#puzzle-status').textContent()) ?? '', /correct so far/)
  const solution = '534678912672195348198342567859761423426853791713924856961537284287419635345286179'
  const sudokuCells = await page.locator('.sudoku-cell').all()
  for (let index = 0; index < sudokuCells.length; index += 1) {
    if (await sudokuCells[index].isEditable()) {
      await sudokuCells[index].fill(solution[index])
    }
  }
  assert.match((await page.locator('#puzzle-status').textContent()) ?? '', /you win/)
  await page.getByRole('button', { name: 'Reset puzzle' }).click()
  assert.equal(await page.locator('#filled-count').textContent(), '0 / 51')
  assert.equal(await page.locator('#sudoku-r1-c1').inputValue(), '5')
  process.stdout.write('PASS Sudoku: validation, arrows, number pad, erase, solution, reset\n')

  await page.goto(url('/interactions.html'))
  await page.getByLabel('Your name', { exact: true }).fill('Jamie')
  await page.getByLabel('Your name', { exact: true }).press('Tab')
  assert.equal(await page.locator('#email').evaluate((cell) => cell === document.activeElement), true)
  await page.getByLabel('Email address', { exact: true }).fill('jamie@example.com')
  await page.getByLabel('Workshop', { exact: true }).selectOption('Photography')
  await page.getByLabel('Guests', { exact: true }).fill('3')
  await page.getByLabel('A note for your host').fill('café ✓\n日本語 👋')
  await page.getByLabel('I understand this is only a practice form').check()
  await page.getByRole('button', { name: 'Reserve my spot' }).click()
  assert.match((await page.locator('#receipt').textContent()) ?? '', /café ✓\n日本語 👋/)
  assert.match((await page.locator('#receipt').textContent()) ?? '', /Workshop: Photography/)
  assert.match((await page.locator('#form-status').textContent()) ?? '', /practice reservation is complete/)
  assert.match((await page.locator('#event-log').textContent()) ?? '', /input.*native/)
  await page.getByRole('button', { name: 'View workshop details' }).click()
  assert.equal(await page.getByRole('dialog').isVisible(), true)
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog').isVisible(), false)
  await page.getByRole('button', { name: 'Collect checkpoint' }).scrollIntoViewIfNeeded()
  await page.getByRole('button', { name: 'Collect checkpoint' }).click()
  assert.match((await page.locator('#checkpoint-status').textContent()) ?? '', /Checkpoint collected/)
  await page.getByRole('button', { name: 'Reset form' }).click()
  assert.equal(await page.locator('#name').inputValue(), '')
  assert.equal(await page.locator('#receipt').isVisible(), false)
  process.stdout.write(
    'PASS Interaction lab: Unicode, Tab, selections, submit, native event journal, dialog, scroll, reset\n',
  )

  for (const path of ['/', '/minesweeper.html', '/sudoku.html', '/interactions.html']) {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(url(path))
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      `${path} overflows a narrow browser`,
    )
  }
  assert.deepEqual(errors, [])
  process.stdout.write('PASS All pages: no runtime errors or horizontal overflow at 390px\n')
} finally {
  await browser.close()
  await server.stop(true)
}

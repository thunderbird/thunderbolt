/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Page } from '@playwright/test'
import { loadCalibration } from './calibration'

/**
 * A deterministic scenario the harness drives in every browser. `interact`
 * exercises the surface after load (navigation, typing, opening panels) so we
 * capture INP, long tasks, and re-renders — not just cold load. Keep each
 * interaction short, idempotent, and free of network sends unless the scenario
 * explicitly targets streaming (which needs an AI key).
 */
export type ScenarioDef = {
  name: string
  path: string
  description: string
  /** Coverage tags for diff-aware selection (map changed files → scenarios). */
  tags: string[]
  /** Interaction run after the route settles; optional for pure load scenarios. */
  interact?: (page: Page) => Promise<void>
}

const settle = (page: Page) => page.waitForLoadState('networkidle').catch(() => {})

/**
 * The canonical sweep. `chat-landing` is first and is the critical surface —
 * it must stay in the entry bundle and feel instant (see AGENTS.md route
 * splitting). Settings/admin routes are lazy chunks; we load them to catch
 * chunk-load waterfalls and per-page render storms.
 */
const BASE_SCENARIOS: ScenarioDef[] = [
  {
    name: 'chat-landing',
    path: '/chats/new',
    description: 'Cold load of the landing chat surface — the primary perf target.',
    tags: ['chat', 'entry', 'critical'],
    interact: async (page) => {
      const input = page.locator('textarea').first()
      await input.click({ timeout: 15_000 }).catch(() => {})
      // Typing exercises INP + reveals re-render storms on the composer without
      // sending a message (no AI key required).
      await input.pressSequentially('performance probe typing test', { delay: 25 }).catch(() => {})
      await input.fill('').catch(() => {})
    },
  },
  {
    name: 'chat-sidebar-nav',
    path: '/chats/new',
    description: 'Open/close the sidebar and navigate chat history — layout + render cost.',
    tags: ['chat', 'sidebar', 'navigation'],
    interact: async (page) => {
      const toggles = page.getByRole('button')
      const count = await toggles.count().catch(() => 0)
      for (let i = 0; i < Math.min(count, 4); i++) {
        await toggles.nth(i).click({ timeout: 3_000, trial: false }).catch(() => {})
        await page.waitForTimeout(150)
      }
    },
  },
  {
    name: 'chat-streaming-sim',
    path: '/message-simulator',
    description:
      'Simulated streaming assistant response via the dev Message Simulator (no API key) — replays a canned SSE log through the real streamText pipeline + production message renderer. Exercises the message-render hot path: streamed markdown, reasoning, and a tool-call block, plus per-chunk streaming re-renders.',
    tags: ['chat', 'streaming', 'message', 'render'],
    interact: async (page) => {
      // Open the SSE-log picker and choose the tool-call fixture (the heaviest
      // render path: streamed markdown + a tool-call block). The Combobox trigger
      // exposes role="combobox"; options render as cmdk items.
      const picker = page.getByRole('combobox').first()
      await picker.click({ timeout: 10_000 }).catch(() => {})
      const option = page.getByRole('option', { name: 'Tool call' }).first()
      await option
        .click({ timeout: 5_000 })
        .catch(() => page.getByText('Tool call', { exact: true }).first().click({ timeout: 5_000 }).catch(() => {}))
      // Run the simulation — it auto-streams through the real pipeline with a fake
      // fetch. The button reads "Stop" while streaming, reverts to "Run" when done.
      await page.getByRole('button', { name: /^Run$/ }).click({ timeout: 10_000 }).catch(() => {})
      await page
        .getByRole('button', { name: /^Stop$/ })
        .waitFor({ state: 'visible', timeout: 10_000 })
        .catch(() => {})
      await page
        .getByRole('button', { name: /^Stop$/ })
        .waitFor({ state: 'detached', timeout: 30_000 })
        .catch(() => {})
      // Let final markdown/syntax-highlighting settle.
      await page.waitForTimeout(500)
    },
  },
  {
    name: 'settings-preferences',
    path: '/settings/preferences',
    description: 'Lazy settings route — chunk-load waterfall + form render cost.',
    tags: ['settings', 'lazy'],
    interact: settle,
  },
  {
    name: 'models',
    path: '/models',
    description: 'Models list — often a large list; watch virtualization + render count.',
    tags: ['settings', 'models', 'list', 'lazy'],
    interact: settle,
  },
  {
    name: 'mcp-servers',
    path: '/mcp-servers',
    description: 'MCP servers admin page (lazy).',
    tags: ['settings', 'mcp', 'lazy'],
    interact: settle,
  },
  {
    name: 'integrations',
    path: '/integrations',
    description: 'Integrations page (lazy).',
    tags: ['settings', 'integrations', 'lazy'],
    interact: settle,
  },
  {
    name: 'devices',
    path: '/devices',
    description: 'Devices page (lazy) — PowerSync/device list rendering.',
    tags: ['settings', 'devices', 'powersync', 'lazy'],
    interact: settle,
  },
]

/**
 * The active scenario set = built-in scenarios + any the crawler discovered and
 * the REFLECT phase promoted into calibration.json. Learned scenarios get a
 * plain "load + settle" interaction (no bespoke steps encodable in JSON).
 */
export const SCENARIOS: ScenarioDef[] = [
  ...BASE_SCENARIOS,
  ...loadCalibration().extraScenarios.map(
    (s): ScenarioDef => ({ ...s, interact: settle }),
  ),
]

/**
 * Maps a changed source path to the scenarios that exercise it, for diff mode.
 * Falls back to the full sweep when nothing matches (unknown blast radius).
 */
export const scenariosForChangedFiles = (files: string[]): ScenarioDef[] => {
  const matched = new Set<ScenarioDef>()
  for (const f of files) {
    const p = f.toLowerCase()
    for (const s of SCENARIOS) {
      if (s.tags.some((t) => p.includes(t)) || p.includes(s.name)) matched.add(s)
    }
    if (p.includes('chat') || p.includes('layout') || p.includes('app.tsx')) {
      matched.add(SCENARIOS[0])
    }
  }
  return matched.size > 0 ? [...matched] : SCENARIOS
}

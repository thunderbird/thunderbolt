/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import AxeBuilder from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

/** One problem found in one screen state. */
export type Finding = {
  state: string
  /** `axe` for axe-core rules, otherwise the scripted check that found it. */
  source: 'axe' | 'reflow' | 'focus-visible' | 'focus-return' | 'duplicate-name'
  rule: string
  /** WCAG success criteria, e.g. `1.4.3`; empty for best-practice rules. */
  criteria: string[]
  impact: string
  summary: string
  count: number
  examples: string[]
  helpUrl?: string
}

export const resultsPath = join(import.meta.dirname, '..', 'results.jsonl')

const record = (finding: Finding) => appendFileSync(resultsPath, `${JSON.stringify(finding)}\n`)

/** `wcag143` → `1.4.3`; `wcag1412` → `1.4.12`. */
const criteriaFromTags = (tags: string[]) =>
  tags
    .filter((tag) => /^wcag\d{3,}$/.test(tag))
    .map((tag) => {
      const digits = tag.slice(4)
      return `${digits[0]}.${digits[1]}.${digits.slice(2)}`
    })

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

/** axe-core over the whole page, every WCAG 2.2 A/AA rule plus best practices. */
export const scanAxe = async (page: Page, state: string) => {
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze()
  for (const violation of results.violations) {
    record({
      state,
      source: 'axe',
      rule: violation.id,
      criteria: criteriaFromTags(violation.tags),
      impact: violation.impact ?? 'unknown',
      summary: violation.help,
      count: violation.nodes.length,
      examples: violation.nodes.slice(0, 3).map((node) => `${node.target.join(' ')} → ${node.html.slice(0, 160)}`),
      helpUrl: violation.helpUrl,
    })
  }
  return results.violations.length
}

/**
 * 1.4.10 Reflow / 1.4.4 Resize: at `width` CSS pixels (320 ≈ 400% zoom of a
 * 1280px window, 640 ≈ 200%) nothing should scroll sideways or be cut off.
 */
export const checkReflow = async (page: Page, state: string, width: 320 | 640) => {
  const original = page.viewportSize()
  await page.setViewportSize({ width, height: width === 320 ? 256 : 512 })
  await page.waitForTimeout(800)
  const problems = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth
    const overflowX = document.documentElement.scrollWidth - viewport
    // Screen-reader-only text is 1px and clipped on purpose.
    const isVisuallyHidden = (element: HTMLElement, rect: DOMRect) =>
      rect.width <= 1 || rect.height <= 1 || getComputedStyle(element).clipPath === 'inset(50%)'
    // Content inside its own horizontal scroller (a data table) is a 1.4.10 exception.
    const inScroller = (element: HTMLElement) => {
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        if (['auto', 'scroll'].includes(getComputedStyle(node).overflowX)) {
          return true
        }
      }
      return false
    }
    const clipped = [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        const hasText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim())
        return (
          hasText &&
          rect.width > 0 &&
          style.visibility !== 'hidden' &&
          !isVisuallyHidden(element, rect) &&
          !inScroller(element) &&
          (rect.right > viewport + 1 || (element.scrollWidth > element.clientWidth + 1 && style.overflowX === 'hidden'))
        )
      })
      .slice(0, 5)
      .map((element) => `<${element.tagName.toLowerCase()}> "${element.textContent?.trim().slice(0, 60)}"`)
    return { overflowX, clipped }
  })
  if (original) {
    await page.setViewportSize(original)
  }
  if (problems.overflowX > 1 || problems.clipped.length > 0) {
    record({
      state,
      source: 'reflow',
      rule: `reflow-${width}px`,
      criteria: ['1.4.10', '1.4.4'],
      impact: 'serious',
      summary: `At ${width}px (${width === 320 ? '400%' : '200%'} zoom) content scrolls sideways or is cut off`,
      count: problems.clipped.length + (problems.overflowX > 1 ? 1 : 0),
      examples: [
        ...(problems.overflowX > 1 ? [`page scrolls sideways by ${problems.overflowX}px`] : []),
        ...problems.clipped,
      ],
    })
  }
}

/**
 * 2.4.7 Focus Visible and 2.4.3 Focus Order: Tab through the page and flag
 * stops whose look doesn't change when focused, or that land on something
 * with no name (focus "on blank space").
 */
export const checkKeyboardFocus = async (page: Page, state: string, maxStops = 40) => {
  // Snapshot every focusable's unfocused look, keyed by a temporary id.
  await page.evaluate(() => {
    const focusable = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'
    const look = (element: Element) => {
      const style = getComputedStyle(element)
      return [
        style.outlineStyle,
        style.outlineWidth,
        style.outlineColor,
        style.boxShadow,
        style.borderColor,
        style.backgroundColor,
        style.textDecorationLine,
      ].join('|')
    }
    document.querySelectorAll(focusable).forEach((element, index) => {
      element.setAttribute('data-a11y-id', String(index))
      element.setAttribute('data-a11y-look', look(element))
    })
    ;(document.activeElement as HTMLElement | null)?.blur()
  })
  const invisible: string[] = []
  const unnamed: string[] = []
  for (let stop = 0; stop < maxStops; stop++) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null
      if (!element || element === document.body) {
        return null
      }
      const style = getComputedStyle(element)
      const look = [
        style.outlineStyle,
        style.outlineWidth,
        style.outlineColor,
        style.boxShadow,
        style.borderColor,
        style.backgroundColor,
        style.textDecorationLine,
      ].join('|')
      const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
      const labels = [...((element as HTMLInputElement).labels ?? [])].map((label) => label.textContent ?? '').join(' ')
      const name = (
        element.getAttribute('aria-label') ??
        element.getAttribute('title') ??
        (`${labelledBy} ${labels}`.trim() || element.textContent) ??
        ''
      ).trim()
      const label = `<${element.tagName.toLowerCase()}${element.getAttribute('role') ? ` role=${element.getAttribute('role')}` : ''}> "${name.slice(0, 50)}"`
      return {
        label,
        changed: element.getAttribute('data-a11y-look') !== look,
        named: name.length > 0 || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA',
      }
    })
    if (!info) {
      break
    }
    if (!info.changed && !invisible.includes(info.label)) {
      invisible.push(info.label)
    }
    if (!info.named && !unnamed.includes(info.label)) {
      unnamed.push(info.label)
    }
  }
  if (invisible.length > 0) {
    record({
      state,
      source: 'focus-visible',
      rule: 'focus-indicator',
      criteria: ['2.4.7', '2.4.13'],
      impact: 'serious',
      summary: 'Keyboard focus lands on controls that look the same focused and unfocused',
      count: invisible.length,
      examples: invisible.slice(0, 6),
    })
  }
  if (unnamed.length > 0) {
    record({
      state,
      source: 'focus-visible',
      rule: 'focus-on-unnamed',
      criteria: ['2.4.3', '4.1.2'],
      impact: 'moderate',
      summary: 'Keyboard focus lands on elements with no name (heard as blank)',
      count: unnamed.length,
      examples: unnamed.slice(0, 6),
    })
  }
}

/** 2.4.3 Focus Order: after a dialog or menu closes with Escape, focus goes back to what opened it. */
export const checkFocusReturn = async (page: Page, state: string, trigger: Locator, label: string) => {
  await trigger.focus()
  await page.keyboard.press('Enter')
  const opened = page.getByRole('menu').or(page.getByRole('dialog')).first()
  await opened.waitFor({ timeout: 5_000 }).catch(() => undefined)
  await page.keyboard.press('Escape')
  await opened.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined)
  const returned = await trigger.evaluate((element) => element === document.activeElement)
  if (!returned) {
    const landed = await page.evaluate(() => {
      const element = document.activeElement
      return element
        ? `<${element.tagName.toLowerCase()}> "${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 50)}"`
        : 'nothing'
    })
    record({
      state,
      source: 'focus-return',
      rule: 'focus-return-after-close',
      criteria: ['2.4.3'],
      impact: 'serious',
      summary: `Closing ${label} with Escape doesn't return focus to the control that opened it`,
      count: 1,
      examples: [`focus went to ${landed}`],
    })
  }
}

/** Visible buttons and links sharing one accessible name, which a screen reader can't tell apart. */
export const checkDuplicateNames = async (page: Page, state: string) => {
  const duplicates = await page.evaluate(() => {
    const names = new Map<string, number>()
    document.querySelectorAll<HTMLElement>('button, a[href], [role="button"], [role="link"]').forEach((element) => {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) {
        return
      }
      const name = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim()
      if (name) {
        names.set(name, (names.get(name) ?? 0) + 1)
      }
    })
    return [...names].filter(([, count]) => count > 1).map(([name, count]) => `"${name}" × ${count}`)
  })
  if (duplicates.length > 0) {
    record({
      state,
      source: 'duplicate-name',
      rule: 'duplicate-control-names',
      criteria: ['2.4.6'],
      impact: 'minor',
      summary: 'Several controls share one name, so a screen reader list of controls is ambiguous',
      count: duplicates.length,
      examples: duplicates.slice(0, 6),
    })
  }
}

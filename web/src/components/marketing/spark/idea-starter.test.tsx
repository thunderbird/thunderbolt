/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IdeaStarter } from './idea-starter'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<IdeaStarter />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

test('workflow selection updates the complete example and exposes exactly one selected choice', () => {
  const choices = [...container.querySelectorAll('button')]
  const example = container.querySelector('[aria-live="polite"]')!
  expect(choices[1].getAttribute('aria-pressed')).toBe('true')
  expect(example.querySelector('h3')!.textContent).toContain('sales spreadsheet')

  for (const [index, prompt, step, detail] of [
    [0, 'this report', 'Pull out the key findings', 'connected search tools'],
    [2, 'signup page', 'Connect an agent', 'computer use'],
    [1, 'sales spreadsheet', 'Inspect the data', 'Thunderbolt CLI'],
  ] as const) {
    act(() => choices[index].click())
    expect(choices.filter((button) => button.getAttribute('aria-pressed') === 'true')).toEqual([choices[index]])
    expect(choices[index].getAttribute('aria-controls')).toBe(example.id)
    expect(example.querySelector('h3')!.textContent).toContain(prompt)
    expect(example.querySelector('li')!.textContent).toContain(step)
    expect(example.querySelector('p')!.textContent).toContain(detail)
    expect(example.querySelectorAll('li')).toHaveLength(3)
  }
})

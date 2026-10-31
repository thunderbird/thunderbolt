/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SlashPopup } from './slash-popup'
import type { SlashItem } from './use-slash-command'

const items: SlashItem[] = ['ask', 'daily-brief', 'map'].map((name) => ({
  kind: 'command',
  id: `command:${name}`,
  name,
  label: name,
  description: '',
}))

const renderPopup = (highlightedIdx: number) => {
  const onHover = mock(() => undefined)
  render(
    <SlashPopup
      items={items}
      agentName="Hermes"
      highlightedIdx={highlightedIdx}
      onSelect={() => undefined}
      onHover={onHover}
    />,
  )
  return { onHover, options: screen.getAllByRole('option') }
}

describe('SlashPopup', () => {
  afterEach(cleanup)

  it('highlights only the selected row, with no hover or transition classes that could disagree with it', () => {
    const { options } = renderPopup(1)
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    for (const option of options) {
      expect(option.className).not.toContain('hover:bg-accent')
      expect(option.className).not.toContain('transition')
    }
  })

  // Scrolling the list under a resting pointer fires mouseenter but never
  // mousemove, so only real pointer movement may move the highlight.
  it('moves the highlight on mouse movement, not mouseenter', () => {
    const { onHover, options } = renderPopup(1)
    fireEvent.mouseEnter(options[0]!)
    expect(onHover).not.toHaveBeenCalled()
    fireEvent.mouseMove(options[0]!)
    expect(onHover).toHaveBeenCalledWith(0)
  })

  it('does not re-dispatch when the pointer moves within the highlighted row', () => {
    const { onHover, options } = renderPopup(1)
    fireEvent.mouseMove(options[1]!)
    expect(onHover).not.toHaveBeenCalled()
  })
})

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { EffortControls } from './effort-controls'

const choices = [
  { value: 'low', name: 'Low' },
  { value: 'high', name: 'High' },
  { value: 'max', name: 'Maximum' },
]
const props = { choices, value: 'low', busy: false, error: null }

afterEach(cleanup)

describe('effort controls', () => {
  it('does not choose an unset effort on secondary-button release', () => {
    const choose = mock()
    render(<EffortControls {...props} value={undefined} choose={choose} />)
    const slider = screen.getByRole('slider')
    fireEvent.pointerUp(slider, { button: 2 })
    expect(choose).not.toHaveBeenCalled()
    expect(slider.getAttribute('data-selected')).toBe('false')
  })

  it('commits the previewed value even if an agent reorders its options during the gesture', () => {
    const choose = mock()
    const view = render(<EffortControls {...props} choose={choose} />)
    const slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '1' } })
    view.rerender(<EffortControls {...props} choices={[choices[1], choices[0], choices[2]]} choose={choose} />)
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    fireEvent.pointerUp(slider)
    expect(choose).toHaveBeenCalledWith('high')
  })

  it('does not commit a previewed option that the agent has removed', () => {
    const choose = mock()
    const view = render(<EffortControls {...props} choose={choose} />)
    const slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '1' } })
    view.rerender(<EffortControls {...props} choices={[choices[0], choices[2]]} choose={choose} />)
    expect(slider.getAttribute('aria-valuetext')).toBe('Low')
    fireEvent.pointerUp(slider)
    expect(choose).not.toHaveBeenCalled()
  })

  it('discards a cancelled gesture without saving on blur', () => {
    const choose = mock()
    render(<EffortControls {...props} choose={choose} />)
    const slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '1' } })
    fireEvent.pointerCancel(slider)
    fireEvent.blur(slider)
    expect(slider.getAttribute('aria-valuetext')).toBe('Low')
    expect(choose).not.toHaveBeenCalled()
  })

  it.each(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])(
    'commits keyboard adjustment on %s',
    (key) => {
      const choose = mock()
      render(<EffortControls {...props} choose={choose} />)
      const slider = screen.getByRole('slider')
      fireEvent.change(slider, { target: { value: '1' } })
      fireEvent.keyUp(slider, { key })
      expect(choose).toHaveBeenCalledWith('high')
      fireEvent.blur(slider)
      expect(choose).toHaveBeenCalledTimes(1)
    },
  )

  it('commits assistive input on blur but ignores unrelated keys', () => {
    const choose = mock()
    render(<EffortControls {...props} choose={choose} />)
    const slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '1' } })
    fireEvent.keyUp(slider, { key: 'Tab' })
    expect(choose).not.toHaveBeenCalled()
    fireEvent.blur(slider)
    expect(choose).toHaveBeenCalledWith('high')
  })

  it('disables native interaction while busy and refuses in-flight commits', () => {
    const choose = mock()
    const view = render(<EffortControls {...props} choose={choose} />)
    const slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '1' } })
    view.rerender(<EffortControls {...props} busy choose={choose} />)
    expect(slider).toBeDisabled()
    fireEvent.pointerUp(slider)
    expect(choose).not.toHaveBeenCalled()
    view.rerender(<EffortControls {...props} choose={choose} />)
    expect(slider.getAttribute('aria-valuetext')).toBe('Low')
  })

  it('allows choosing a sole advertised value once and renders save errors', () => {
    const choose = mock()
    const view = render(<EffortControls {...props} value={undefined} choices={[choices[0]]} choose={choose} />)
    const slider = screen.getByRole('slider')
    expect(slider).not.toBeDisabled()
    fireEvent.pointerUp(slider)
    expect(choose).toHaveBeenCalledWith('low')
    view.rerender(<EffortControls {...props} choices={[choices[0]]} choose={choose} error="Could not save" />)
    expect(slider).toBeDisabled()
    expect(screen.getByRole('alert').textContent).toBe('Could not save')
  })
})

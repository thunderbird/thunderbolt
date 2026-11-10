/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { createRef } from 'react'
import { BrowserAddressBar } from './browser-address-bar'

/** Render real address-bar controls with a controlled navigation boundary. */
const renderAddressBar = (overrides: Partial<Parameters<typeof BrowserAddressBar>[0]> = {}) => {
  const props = {
    url: 'https://example.com/',
    inputRef: createRef<HTMLInputElement>(),
    disabled: false,
    onNavigate: mock(async (_url: string) => true),
    ...overrides,
  }
  return { ...render(<BrowserAddressBar {...props} />), props }
}

describe('BrowserAddressBar', () => {
  it.each([
    ['mozilla.org', 'https://mozilla.org/'],
    ['localhost:5173/docs', 'http://localhost:5173/docs'],
  ])('submits %s as an address', async (input, expected) => {
    const { getByRole, props } = renderAddressBar()
    const address = getByRole('textbox', { name: 'Address' })
    fireEvent.change(address, { target: { value: input } })
    await act(async () => fireEvent.submit(address.closest('form')!))
    expect(props.onNavigate).toHaveBeenCalledWith(expected)
  })

  it.each(['', 'https://', 'javascript:alert(1)', 'weather tomorrow', 'localhost:abc'])(
    'disables invalid input %s without showing an error',
    async (value) => {
      const { getByRole, queryByRole, props } = renderAddressBar({ url: '' })
      const address = getByRole('textbox', { name: 'Address' })
      fireEvent.change(address, { target: { value } })
      expect(getByRole('button', { name: 'Go' })).toBeDisabled()
      await act(async () => fireEvent.submit(address.closest('form')!))
      expect(props.onNavigate).not.toHaveBeenCalled()
      expect(address).not.toHaveAttribute('aria-invalid')
      expect(queryByRole('alert')).toBeNull()
      fireEvent.change(address, { target: { value: 'https://safe.example/' } })
      expect(getByRole('button', { name: 'Go' })).toBeEnabled()
      fireEvent.change(address, { target: { value: '' } })
      expect(getByRole('button', { name: 'Go' })).toBeDisabled()
    },
  )

  it('shows redirect URLs without overwriting an unfinished address edit', () => {
    const { getByRole, rerender, props } = renderAddressBar()
    const address = getByRole('textbox', { name: 'Address' })
    rerender(<BrowserAddressBar {...props} url="https://redirect.example/" />)
    expect(address).toHaveValue('https://redirect.example/')
    fireEvent.focus(address)
    fireEvent.change(address, { target: { value: 'my unfinished search' } })
    rerender(<BrowserAddressBar {...props} url="https://final.example/" />)
    expect(address).toHaveValue('my unfinished search')
    fireEvent.keyDown(address, { key: 'Escape' })
    expect(address).toHaveValue('https://final.example/')
  })

  it('follows the current URL after focus leaves the address form', () => {
    const { getByRole, rerender, props } = renderAddressBar()
    const address = getByRole('textbox', { name: 'Address' })
    fireEvent.focus(address)
    fireEvent.blur(address, { relatedTarget: document.body })
    rerender(<BrowserAddressBar {...props} url="https://linked.example/" />)
    expect(address).toHaveValue('https://linked.example/')

    fireEvent.focus(address)
    fireEvent.change(address, { target: { value: 'unfinished edit' } })
    const go = getByRole('button', { name: 'Go' })
    fireEvent.blur(address, { relatedTarget: go })
    expect(address).toHaveValue('unfinished edit')
    fireEvent.blur(go, { relatedTarget: document.body })
    expect(address).toHaveValue('https://linked.example/')
  })

  it('preserves the edited URL when focus moves to Go before submission', async () => {
    const { getByRole, props } = renderAddressBar()
    const address = getByRole('textbox', { name: 'Address' })
    fireEvent.focus(address)
    fireEvent.change(address, { target: { value: 'edited.example' } })
    fireEvent.blur(address, { relatedTarget: getByRole('button', { name: 'Go' }) })
    await act(async () => fireEvent.submit(address.closest('form')!))
    expect(props.onNavigate).toHaveBeenCalledWith('https://edited.example/')
  })

  it('keeps the draft through WebKit pointer submission when buttons do not receive focus', async () => {
    const { getByRole, props } = renderAddressBar({ url: '' })
    const address = getByRole('textbox', { name: 'Address' })
    act(() => address.focus())
    fireEvent.change(address, { target: { value: 'localhost:4174/sudoku.html' } })
    const go = getByRole('button', { name: 'Go' })
    const allowNativeFocusChange = fireEvent.mouseDown(go)
    if (allowNativeFocusChange) {
      fireEvent.blur(address, { relatedTarget: null })
    }
    await act(async () => fireEvent.click(go))
    expect(props.onNavigate).toHaveBeenCalledWith('http://localhost:4174/sudoku.html')
  })

  it('does not clear or blur a newer edit when an earlier navigation finishes', async () => {
    let finishNavigation: (success: boolean) => void = () => {}
    const completion = new Promise<boolean>((resolve) => {
      finishNavigation = resolve
    })
    const onNavigate = mock((_url: string) => completion)
    const { getByRole } = renderAddressBar({ onNavigate })
    const address = getByRole('textbox', { name: 'Address' })
    act(() => address.focus())
    fireEvent.change(address, { target: { value: 'first.example' } })
    fireEvent.submit(address.closest('form')!)
    fireEvent.change(address, { target: { value: 'second.example' } })
    await act(async () => {
      finishNavigation(true)
      await completion
    })
    expect(address).toHaveValue('second.example')
    expect(address).toHaveFocus()
  })

  it('keeps the entered address when navigation fails', async () => {
    const onNavigate = mock(async (_url: string) => false)
    const { getByRole } = renderAddressBar({ onNavigate })
    const address = getByRole('textbox', { name: 'Address' })
    fireEvent.change(address, { target: { value: 'unreachable.example' } })
    await act(async () => fireEvent.submit(address.closest('form')!))
    expect(address).toHaveValue('unreachable.example')
    expect(onNavigate).toHaveBeenCalledWith('https://unreachable.example/')
  })

  it('prevents form submission until the native browser is initialized', async () => {
    const { getByRole, props } = renderAddressBar({ disabled: true })
    const address = getByRole('textbox', { name: 'Address' })
    fireEvent.change(address, { target: { value: 'mozilla.org' } })
    await act(async () => fireEvent.submit(address.closest('form')!))
    expect(getByRole('button', { name: 'Go' })).toBeDisabled()
    expect(props.onNavigate).not.toHaveBeenCalled()
  })

  it('keeps the entire URL selected after the first pointer click but allows subsequent caret placement', () => {
    const { getByRole, props } = renderAddressBar()
    const address = getByRole('textbox', { name: 'Address' }) as HTMLInputElement
    fireEvent.pointerDown(address)
    fireEvent.mouseDown(address)
    act(() => address.focus())
    address.setSelectionRange(3, 3)
    fireEvent.pointerUp(address)
    fireEvent.click(address)
    expect(address.selectionStart).toBe(0)
    expect(address.selectionEnd).toBe(props.url.length)
    fireEvent.pointerDown(address)
    fireEvent.mouseDown(address)
    address.setSelectionRange(8, 8)
    fireEvent.pointerUp(address)
    fireEvent.click(address)
    expect(address.selectionStart).toBe(8)
    expect(address.selectionEnd).toBe(8)
  })
})

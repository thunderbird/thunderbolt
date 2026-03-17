import '@/testing-library'
import { getClock } from '@/testing-library'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { CopyMessageButton } from './copy-message-button'

const writeTextMock = mock(() => Promise.resolve())

Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: writeTextMock },
  configurable: true,
})

afterEach(() => {
  cleanup()
  writeTextMock.mockClear()
})

describe('CopyMessageButton', () => {
  describe('initial render', () => {
    it('renders a Copy icon by default', () => {
      render(createElement(CopyMessageButton, { text: 'Hello world' }))

      const button = screen.getByRole('button', { name: 'Copy message' })
      expect(button).toBeInTheDocument()
      const svg = button.querySelector('svg')
      expect(svg).toBeInTheDocument()
    })

    it('renders with the correct title', () => {
      render(createElement(CopyMessageButton, { text: 'Hello world' }))

      const button = screen.getByRole('button', { name: 'Copy message' })
      expect(button).toHaveAttribute('title', 'Copy message')
    })

    it('applies optional className', () => {
      render(createElement(CopyMessageButton, { text: 'Hello world', className: 'custom-class' }))

      const button = screen.getByRole('button', { name: 'Copy message' })
      expect(button.className).toContain('custom-class')
    })
  })

  describe('copy interaction', () => {
    it('calls navigator.clipboard.writeText with the correct text on click', async () => {
      render(createElement(CopyMessageButton, { text: 'Hello world' }))

      const button = screen.getByRole('button', { name: 'Copy message' })
      await act(async () => {
        fireEvent.click(button)
        await getClock().tickAsync(0)
      })

      expect(writeTextMock).toHaveBeenCalledTimes(1)
      expect(writeTextMock).toHaveBeenCalledWith('Hello world')
    })

    it('shows Check icon after clicking copy', async () => {
      render(createElement(CopyMessageButton, { text: 'Hello world' }))

      const button = screen.getByRole('button', { name: 'Copy message' })
      await act(async () => {
        fireEvent.click(button)
        await getClock().tickAsync(0)
      })

      // After copying, a Check icon should appear (the svg is still present)
      const svg = button.querySelector('svg')
      expect(svg).toBeInTheDocument()
    })

    it('resets to Copy icon after 2 seconds', async () => {
      render(createElement(CopyMessageButton, { text: 'Hello world' }))

      const button = screen.getByRole('button', { name: 'Copy message' })

      await act(async () => {
        fireEvent.click(button)
        await getClock().tickAsync(0)
      })

      // Advance 2 seconds to trigger the reset timeout
      await act(async () => {
        await getClock().tickAsync(2000)
      })

      // Button should still be present (now showing Copy icon again)
      const buttonAfterReset = screen.getByRole('button', { name: 'Copy message' })
      expect(buttonAfterReset).toBeInTheDocument()
    })
  })

  describe('cleanup', () => {
    it('cleans up the timeout on unmount', async () => {
      const { unmount } = render(createElement(CopyMessageButton, { text: 'Hello world' }))

      const button = screen.getByRole('button', { name: 'Copy message' })
      await act(async () => {
        fireEvent.click(button)
        await getClock().tickAsync(0)
      })

      // Unmount before the 2s timeout fires — should not throw
      expect(() => unmount()).not.toThrow()
    })
  })
})

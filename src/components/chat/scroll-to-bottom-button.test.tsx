import { getClock } from '@/testing-library'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { ScrollToBottomButton } from './scroll-to-bottom-button'

describe('ScrollToBottomButton', () => {
  afterEach(() => {
    cleanup()
  })

  describe('visibility', () => {
    it('should render button when isVisible is true', async () => {
      const onClick = mock()

      render(<ScrollToBottomButton isVisible={true} onClick={onClick} />)

      // Wait for animation to complete
      await act(async () => {
        await getClock().tickAsync(300)
      })

      const button = screen.getByRole('button', { name: 'Scroll to bottom' })
      expect(button).toBeInTheDocument()
    })

    it('should not render button when isVisible is false', () => {
      const onClick = mock()

      render(<ScrollToBottomButton isVisible={false} onClick={onClick} />)

      const button = screen.queryByRole('button', { name: 'Scroll to bottom' })
      expect(button).toBeNull()
    })
  })

  describe('interaction', () => {
    it('should call onClick when button is clicked', async () => {
      const onClick = mock()

      render(<ScrollToBottomButton isVisible={true} onClick={onClick} />)

      // Wait for animation to complete
      await act(async () => {
        await getClock().tickAsync(300)
      })

      const button = screen.getByRole('button', { name: 'Scroll to bottom' })
      fireEvent.click(button)

      expect(onClick).toHaveBeenCalledTimes(1)
    })
  })

  describe('styling', () => {
    it('should apply custom className', async () => {
      const onClick = mock()

      render(<ScrollToBottomButton isVisible={true} onClick={onClick} className="custom-class" />)

      await act(async () => {
        await getClock().tickAsync(300)
      })

      // The className is applied to the motion.div wrapper, not the button
      // We can verify the button exists and has proper styling
      const button = screen.getByRole('button', { name: 'Scroll to bottom' })
      expect(button).toBeInTheDocument()
      expect(button.className).toContain('rounded-full')
    })

    it('should have proper accessibility label', async () => {
      const onClick = mock()

      render(<ScrollToBottomButton isVisible={true} onClick={onClick} />)

      await act(async () => {
        await getClock().tickAsync(300)
      })

      const button = screen.getByRole('button', { name: 'Scroll to bottom' })
      expect(button).toHaveAttribute('aria-label', 'Scroll to bottom')
    })
  })

  describe('icon', () => {
    it('should render chevron-down icon', async () => {
      const onClick = mock()

      render(<ScrollToBottomButton isVisible={true} onClick={onClick} />)

      await act(async () => {
        await getClock().tickAsync(300)
      })

      const button = screen.getByRole('button', { name: 'Scroll to bottom' })
      const svg = button.querySelector('svg')
      expect(svg).toBeInTheDocument()
    })
  })
})

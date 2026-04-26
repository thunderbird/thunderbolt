import { maxRetries } from '@/chats/constants'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { ErrorMessage } from './error-message'

afterEach(cleanup)

describe('ErrorMessage', () => {
  describe('rate limit errors', () => {
    it('should show rate limit message for JSON 429 status', () => {
      const error = new Error(JSON.stringify({ error: 'Rate limited', status: 429 }))
      render(<ErrorMessage retryCount={0} retriesExhausted={false} error={error} />)

      expect(screen.getByText('Too many requests. Please try again in a moment.')).toBeTruthy()
    })

    it('should show rate limit message for JSON 429 statusCode', () => {
      const error = new Error(JSON.stringify({ error: 'Rate limited', statusCode: 429 }))
      render(<ErrorMessage retryCount={0} retriesExhausted={false} error={error} />)

      expect(screen.getByText('Too many requests. Please try again in a moment.')).toBeTruthy()
    })

    it('should show rate limit message for "too many requests" string', () => {
      const error = new Error('Too many requests. Please try again later.')
      render(<ErrorMessage retryCount={0} retriesExhausted={false} error={error} />)

      expect(screen.getByText('Too many requests. Please try again in a moment.')).toBeTruthy()
    })

    it('should not show retry button or spinner for rate limit errors', () => {
      const error = new Error(JSON.stringify({ error: 'Rate limited', status: 429 }))
      const onRetry = mock(() => {})
      render(<ErrorMessage retryCount={1} retriesExhausted={false} error={error} onRetry={onRetry} />)

      expect(screen.queryByText('Retry')).toBeNull()
      expect(screen.queryByText(/Retrying/)).toBeNull()
    })

    it('should take priority over retry state', () => {
      const error = new Error(JSON.stringify({ error: 'Rate limited', status: 429 }))
      render(<ErrorMessage retryCount={2} retriesExhausted={false} error={error} />)

      expect(screen.getByText('Too many requests. Please try again in a moment.')).toBeTruthy()
      expect(screen.queryByText(/Retrying/)).toBeNull()
    })
  })

  describe('auto-retry in progress', () => {
    it('should show retry spinner when retryCount > 0 and retries not exhausted', () => {
      render(<ErrorMessage retryCount={1} retriesExhausted={false} />)

      expect(screen.getByText(`Something went wrong. Retrying (1/${maxRetries})...`)).toBeTruthy()
    })

    it('should update retry count display', () => {
      render(<ErrorMessage retryCount={2} retriesExhausted={false} />)

      expect(screen.getByText(`Something went wrong. Retrying (2/${maxRetries})...`)).toBeTruthy()
    })

    it('should not show retry spinner when retries are exhausted', () => {
      render(<ErrorMessage retryCount={3} retriesExhausted={true} />)

      expect(screen.queryByText(/Retrying/)).toBeNull()
    })
  })

  describe('generic error with retry button', () => {
    it('should show error message and retry button when retries exhausted', () => {
      const onRetry = mock(() => {})
      render(<ErrorMessage retryCount={0} retriesExhausted={true} onRetry={onRetry} />)

      expect(screen.getByText('Something went wrong. Please try again.')).toBeTruthy()
      expect(screen.getByText('Retry')).toBeTruthy()
    })

    it('should show error message when retryCount is 0 (fresh error)', () => {
      render(<ErrorMessage retryCount={0} retriesExhausted={false} />)

      expect(screen.getByText('Something went wrong. Please try again.')).toBeTruthy()
    })

    it('should call onRetry when retry button is clicked', () => {
      const onRetry = mock(() => {})
      render(<ErrorMessage retryCount={0} retriesExhausted={true} onRetry={onRetry} />)

      fireEvent.click(screen.getByText('Retry'))
      expect(onRetry).toHaveBeenCalledTimes(1)
    })

    it('should not show retry button when onRetry is not provided', () => {
      render(<ErrorMessage retryCount={0} retriesExhausted={true} />)

      expect(screen.queryByText('Retry')).toBeNull()
    })
  })

  describe('edge cases', () => {
    it('should handle null error without crashing', () => {
      render(<ErrorMessage retryCount={0} retriesExhausted={false} error={null} />)

      expect(screen.getByText('Something went wrong. Please try again.')).toBeTruthy()
    })

    it('should handle undefined error without crashing', () => {
      render(<ErrorMessage retryCount={0} retriesExhausted={false} error={undefined} />)

      expect(screen.getByText('Something went wrong. Please try again.')).toBeTruthy()
    })

    it('should handle non-rate-limit error with retry in progress', () => {
      const error = new Error('Network timeout')
      render(<ErrorMessage retryCount={1} retriesExhausted={false} error={error} />)

      expect(screen.getByText(`Something went wrong. Retrying (1/${maxRetries})...`)).toBeTruthy()
    })
  })
})

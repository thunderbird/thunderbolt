import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeAll, afterAll, mock, spyOn } from 'bun:test'
import '@testing-library/jest-dom'
import { Component } from 'react'
import { ErrorBoundary } from './error-boundary'

// Component that throws an error for testing
type ThrowErrorProps = {
  shouldThrow?: boolean
  errorMessage?: string
}

class ThrowError extends Component<ThrowErrorProps> {
  render() {
    if (this.props.shouldThrow) {
      throw new Error(this.props.errorMessage || 'Test error')
    }
    return <div>No error</div>
  }
}

describe('ErrorBoundary', () => {
  // Suppress expected console errors in tests
  beforeAll(() => {
    spyOn(console, 'error').mockImplementation(() => {})
  })

  afterAll(() => {
    ;(console.error as ReturnType<typeof spyOn>).mockRestore?.()
  })

  it('should render children when there is no error', () => {
    render(
      <ErrorBoundary>
        <div>Test content</div>
      </ErrorBoundary>,
    )

    expect(screen.getByText('Test content')).toBeInTheDocument()
  })

  it('should catch errors and display error UI', () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} errorMessage="Test error message" />
      </ErrorBoundary>,
    )

    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByText('Test error message')).toBeInTheDocument()
  })

  it('should display reload and contact support buttons when error occurs', () => {
    const reloadSpy = mock()
    Object.defineProperty(window, 'location', {
      value: { reload: reloadSpy },
      writable: true,
    })

    const openSpy = mock()
    window.open = openSpy

    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} errorMessage="Test error" />
      </ErrorBoundary>,
    )

    const reloadButton = screen.getByRole('button', { name: 'Reload' })
    const supportButton = screen.getByRole('button', { name: 'Contact Support' })

    expect(reloadButton).toBeInTheDocument()
    expect(supportButton).toBeInTheDocument()

    fireEvent.click(reloadButton)
    expect(reloadSpy).toHaveBeenCalledTimes(1)

    fireEvent.click(supportButton)
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(openSpy.mock.calls[0][0]).toContain('mailto:support@thunderbird.net')
  })
})

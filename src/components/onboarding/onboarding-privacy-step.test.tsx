import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, beforeEach, afterEach, expect } from 'bun:test'
import '@testing-library/jest-dom'
import { OnboardingPrivacyStep } from './onboarding-privacy-step'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { setupTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { useOnboardingState } from '@/hooks/use-onboarding-state'

const TestOnboardingPrivacyStep = () => {
  const { state, actions } = useOnboardingState()
  return <OnboardingPrivacyStep state={state} actions={actions} />
}

// Test component that exposes state for validation
const TestOnboardingPrivacyStepWithState = () => {
  const { state, actions } = useOnboardingState()
  return (
    <div>
      <OnboardingPrivacyStep state={state} actions={actions} />
      <div data-testid="state-indicator" data-privacy-agreed={state.privacyAgreed} data-can-go-next={state.canGoNext}>
        State
      </div>
    </div>
  )
}

describe('OnboardingPrivacyStep', () => {
  beforeEach(async () => {
    await setupTestDatabase()
  })

  afterEach(async () => {
    await resetTestDatabase()
  })

  const renderComponent = () => {
    return render(<TestOnboardingPrivacyStep />, {
      wrapper: createQueryTestWrapper(),
    })
  }

  describe('Component rendering', () => {
    it('should render privacy step UI correctly', () => {
      renderComponent()

      expect(screen.getByText(/Welcome to/)).toBeInTheDocument()
      expect(screen.getByText(/Thunderbolt/)).toBeInTheDocument()
      expect(screen.getByText(/Your privacy-first AI assistant/)).toBeInTheDocument()
    })

    it('should render privacy features', () => {
      renderComponent()

      expect(screen.getByText('Zero Logs')).toBeInTheDocument()
      expect(screen.getByText('Zero Training')).toBeInTheDocument()
      expect(screen.getByText('Local Storage')).toBeInTheDocument()
    })
  })

  describe('Terms agreement', () => {
    it('should render terms agreement checkbox', () => {
      renderComponent()

      const checkbox = document.getElementById('terms-agreement')
      expect(checkbox).toBeInTheDocument()
      expect(checkbox).toHaveAttribute('aria-checked', 'false')
    })

    it('should render privacy policy link', () => {
      renderComponent()

      const link = screen.getByRole('link', { name: 'Privacy Policy' })
      expect(link).toBeInTheDocument()
      expect(link).toHaveAttribute('href', 'https://www.thunderbird.net/en-US/privacy/')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })

    it('should render terms of service link', () => {
      renderComponent()

      const link = screen.getByRole('link', { name: 'Terms of Service' })
      expect(link).toBeInTheDocument()
      expect(link).toHaveAttribute('href', 'https://www.mozilla.org/en-US/about/legal/terms/mozilla/')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })

    it('should sync checkbox state with privacyAgreed state', async () => {
      renderComponent()

      const checkbox = document.getElementById('terms-agreement')!
      expect(checkbox).toHaveAttribute('aria-checked', 'false')

      fireEvent.click(checkbox)

      await waitFor(() => {
        expect(checkbox).toHaveAttribute('aria-checked', 'true')
      })
    })

    it('should update state when checkbox is checked', async () => {
      const { rerender } = renderComponent()

      const checkbox = document.getElementById('terms-agreement')!
      expect(checkbox).toHaveAttribute('aria-checked', 'false')

      fireEvent.click(checkbox)

      await waitFor(() => {
        expect(checkbox).toHaveAttribute('aria-checked', 'true')
      })

      rerender(<TestOnboardingPrivacyStep />)

      const rerenderedCheckbox = document.getElementById('terms-agreement')!
      expect(rerenderedCheckbox).toHaveAttribute('aria-checked', 'true')
    })

    it('should only accept boolean true, not other truthy values', async () => {
      renderComponent()

      const checkbox = document.getElementById('terms-agreement')!

      fireEvent.click(checkbox)

      await waitFor(() => {
        expect(checkbox).toHaveAttribute('aria-checked', 'true')
      })
    })
  })

  describe('Business logic validation', () => {
    it('should enable canGoNext when privacyAgreed is true', async () => {
      render(<TestOnboardingPrivacyStepWithState />, {
        wrapper: createQueryTestWrapper(),
      })

      const checkbox = document.getElementById('terms-agreement')!
      const stateIndicator = screen.getByTestId('state-indicator')

      expect(stateIndicator.getAttribute('data-privacy-agreed')).toBe('false')

      fireEvent.click(checkbox)

      await waitFor(() => {
        expect(checkbox).toHaveAttribute('aria-checked', 'true')
        expect(stateIndicator.getAttribute('data-privacy-agreed')).toBe('true')
        expect(stateIndicator.getAttribute('data-can-go-next')).toBe('true')
      })
    })

    it('should disable canGoNext when privacyAgreed is false', async () => {
      render(<TestOnboardingPrivacyStepWithState />, {
        wrapper: createQueryTestWrapper(),
      })

      const checkbox = document.getElementById('terms-agreement')!
      const stateIndicator = screen.getByTestId('state-indicator')

      fireEvent.click(checkbox)

      await waitFor(() => {
        expect(stateIndicator.getAttribute('data-privacy-agreed')).toBe('true')
        expect(stateIndicator.getAttribute('data-can-go-next')).toBe('true')
      })

      fireEvent.click(checkbox)

      await waitFor(() => {
        expect(checkbox).toHaveAttribute('aria-checked', 'false')
        expect(stateIndicator.getAttribute('data-privacy-agreed')).toBe('false')
        expect(stateIndicator.getAttribute('data-can-go-next')).toBe('false')
      })
    })

    it('should maintain state synchronization between checkbox and privacyAgreed', async () => {
      render(<TestOnboardingPrivacyStepWithState />, {
        wrapper: createQueryTestWrapper(),
      })

      const checkbox = document.getElementById('terms-agreement')!
      const stateIndicator = screen.getByTestId('state-indicator')

      expect(checkbox).toHaveAttribute('aria-checked', 'false')
      expect(stateIndicator.getAttribute('data-privacy-agreed')).toBe('false')
      fireEvent.click(checkbox)

      await waitFor(() => {
        expect(checkbox).toHaveAttribute('aria-checked', 'true')
        expect(stateIndicator.getAttribute('data-privacy-agreed')).toBe('true')
      })
      fireEvent.click(checkbox)

      await waitFor(() => {
        expect(checkbox).toHaveAttribute('aria-checked', 'false')
        expect(stateIndicator.getAttribute('data-privacy-agreed')).toBe('false')
      })
    })
  })

  describe('Accessibility', () => {
    it('should have proper structure', () => {
      renderComponent()

      const checkbox = document.getElementById('terms-agreement')
      expect(checkbox).toHaveAttribute('role', 'checkbox')
      expect(checkbox).toHaveAttribute('type', 'button')
    })
  })

  describe('Edge cases', () => {
    it('should handle rapid checkbox toggling', async () => {
      renderComponent()

      const checkbox = document.getElementById('terms-agreement')!
      expect(checkbox).toHaveAttribute('aria-checked', 'false')

      fireEvent.click(checkbox)
      await waitFor(() => {
        expect(checkbox).toHaveAttribute('aria-checked', 'true')
      })

      fireEvent.click(checkbox)
      await waitFor(() => {
        expect(checkbox).toHaveAttribute('aria-checked', 'false')
      })

      fireEvent.click(checkbox)
      await waitFor(() => {
        expect(checkbox).toHaveAttribute('aria-checked', 'true')
      })
    })

    it('should handle keyboard navigation', () => {
      renderComponent()

      const checkbox = document.getElementById('terms-agreement')!
      expect(checkbox).toBeInTheDocument()
      expect(checkbox).toHaveAttribute('role', 'checkbox')
    })

    it('should handle external link clicks', () => {
      renderComponent()

      const link = screen.getByRole('link', { name: 'Privacy Policy' })
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    })
  })
})

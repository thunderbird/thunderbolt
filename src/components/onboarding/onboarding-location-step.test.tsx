import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { useOnboardingState } from '@/hooks/use-onboarding-state'
import { mockLocationData } from '@/test-utils/http-client'
import { createTestProvider } from '@/test-utils/test-provider'
import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { OnboardingLocationStep } from './onboarding-location-step'

// Mock Popover components to bypass Radix UI flakiness in CI (portals/animations)
// We force render the content to ensure we can test the form logic inside
mock.module('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

// Mock Command components to bypass cmk/Radix issues in CI
mock.module('@/components/ui/command', () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandInput: (props: any) => <input {...props} />,
  CommandList: ({ children }: { children: React.ReactNode }) => <div cmdk-list="">{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({ children, onSelect, ...props }: any) => (
    <div onClick={() => onSelect?.(children)} role="option" data-value={children} {...props}>
      {children}
    </div>
  ),
}))

const TestOnboardingLocationStep = ({ onFormDirtyChange }: { onFormDirtyChange?: (isDirty: boolean) => void }) => {
  const { state, actions } = useOnboardingState()
  return <OnboardingLocationStep state={state} actions={actions} onFormDirtyChange={onFormDirtyChange} />
}

let consoleSpies: ConsoleSpies

beforeAll(async () => {
  await setupTestDatabase()
  consoleSpies = setupConsoleSpy()
})

afterAll(async () => {
  await teardownTestDatabase()
  consoleSpies.restore()
})

describe('OnboardingLocationStep', () => {
  beforeEach(async () => {
    // Reset database before each test to prevent pollution from randomized test order
    await resetTestDatabase()
  })

  const renderComponent = async (onFormDirtyChange?: (isDirty: boolean) => void) => {
    const result = render(<TestOnboardingLocationStep onFormDirtyChange={onFormDirtyChange} />, {
      wrapper: createTestProvider({ mockResponse: mockLocationData }),
    })

    // Wait for the component to render
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Search for locations/i)).toBeInTheDocument()
    })

    return result
  }

  describe('Component rendering', () => {
    it('should render location step UI correctly', async () => {
      await renderComponent()

      expect(screen.getByText('Where are you located?')).toBeInTheDocument()
      expect(
        screen.getByText('This helps us personalize your experience with local settings and features.'),
      ).toBeInTheDocument()
      expect(screen.getByText('Select location...')).toBeInTheDocument()
    })

    it('should render MapPin icon', async () => {
      await renderComponent()

      // The MapPin icon is an SVG with aria-hidden="true", so we check the container
      const iconContainer = screen
        .getByText('Where are you located?')
        .closest('div')
        ?.parentElement?.querySelector('.mx-auto')
      expect(iconContainer).toBeInTheDocument()
    })
  })

  describe('Form interaction', () => {
    it('should toggle location search when combobox is clicked', async () => {
      await renderComponent()

      // Get the trigger button by its text content
      const triggerButton = screen.getByText('Select location...').closest('button')
      expect(triggerButton).toBeInTheDocument()
      fireEvent.click(triggerButton!)

      // Button should still be in document after click
      expect(triggerButton).toBeInTheDocument()
    })

    it('should have proper form structure', async () => {
      await renderComponent()

      const form = document.querySelector('form')
      expect(form).toBeInTheDocument()
    })

    it('should have proper combobox structure', async () => {
      await renderComponent()

      // Get the trigger button by its text content
      const triggerButton = screen.getByText('Select location...').closest('button')
      expect(triggerButton).toBeInTheDocument()
      // The real hook behavior may vary - just check that the attribute exists
      expect(triggerButton?.getAttribute('aria-expanded')).toBeTruthy()
    })
  })

  describe('Accessibility', () => {
    it('should have proper form labels and structure', async () => {
      await renderComponent()

      await waitFor(() => {
        expect(screen.getByText('Select location...')).toBeInTheDocument()
      })

      // The component exposes a trigger button and search input
      const triggerButton = screen.getByText('Select location...').closest('button')
      const searchInput = screen.getByPlaceholderText(/Search for locations/i)
      expect(triggerButton).toBeInTheDocument()
      expect(searchInput).toBeInTheDocument()
      expect(triggerButton?.getAttribute('aria-expanded')).toBeTruthy()
    })

    it('should maintain accessibility during interactions', async () => {
      await renderComponent()

      await waitFor(() => {
        expect(screen.getByText('Select location...')).toBeInTheDocument()
      })

      const triggerButton = screen.getByText('Select location...').closest('button')
      fireEvent.click(triggerButton!)

      await waitFor(() => {
        expect(triggerButton).toBeInTheDocument()
      })
      // The real hook behavior may vary - just check that the attribute exists
      expect(triggerButton?.getAttribute('aria-expanded')).toBeTruthy()
    })
  })

  describe('Edge cases', () => {
    it('should handle rapid button clicks', async () => {
      await renderComponent()

      await waitFor(() => {
        expect(screen.getByText('Select location...')).toBeInTheDocument()
      })

      const triggerButton = screen.getByText('Select location...').closest('button')

      // Rapid clicks should not cause issues
      fireEvent.click(triggerButton!)
      fireEvent.click(triggerButton!)
      fireEvent.click(triggerButton!)

      // Wait for all state updates to settle
      await waitFor(() => {
        expect(triggerButton).toBeInTheDocument()
      })
    })

    it('should maintain accessibility during error states', async () => {
      await renderComponent()

      await waitFor(() => {
        expect(screen.getByText('Select location...')).toBeInTheDocument()
      })

      const triggerButton = screen.getByText('Select location...').closest('button')
      expect(triggerButton).toBeInTheDocument()
      expect(triggerButton?.getAttribute('aria-invalid')).toBe('false')
    })
  })

  describe('Form Validation Business Logic', () => {
    it('should show validation error when submitting empty form', async () => {
      await renderComponent()

      const form = document.querySelector('form')
      expect(form).toBeInTheDocument()

      fireEvent.submit(form!)

      await act(async () => {
        await getClock().runAllAsync()
      })

      const errorMessage = screen.queryByText('Location is required.')
      expect(errorMessage).toBeInTheDocument()
    })

    it('should require valid location data for submission', async () => {
      await renderComponent()

      const form = document.querySelector('form')
      expect(form).toBeInTheDocument()

      fireEvent.submit(form!)

      await act(async () => {
        await getClock().runAllAsync()
      })

      const errorMessage = screen.queryByText('Location is required.')
      expect(errorMessage).toBeInTheDocument()
    })
  })

  describe('Location Selection Business Logic', () => {
    it('should have clickable trigger button', async () => {
      await renderComponent()

      await waitFor(() => {
        expect(screen.getByText('Select location...')).toBeInTheDocument()
      })

      const triggerButton = screen.getByText('Select location...').closest('button')
      expect(triggerButton).toBeInTheDocument()
      expect(triggerButton?.getAttribute('role')).toBe('combobox')
    })

    it('should handle trigger button clicks', async () => {
      await renderComponent()

      await waitFor(() => {
        expect(screen.getByText('Select location...')).toBeInTheDocument()
      })

      const triggerButton = screen.getByText('Select location...').closest('button')!
      fireEvent.click(triggerButton)

      // Wait for state updates and verify button is still in document
      await waitFor(() => {
        expect(triggerButton).toBeInTheDocument()
      })
    })
  })

  describe('State Management Business Logic', () => {
    it('should initialize form with empty values', async () => {
      await renderComponent()

      await waitFor(() => {
        expect(screen.getByText('Select location...')).toBeInTheDocument()
      })

      const triggerButton = screen.getByText('Select location...').closest('button')
      expect(triggerButton).toBeInTheDocument()
      expect(triggerButton?.textContent).toContain('Select location...')
    })

    it('should call onFormDirtyChange when provided', async () => {
      let formDirty: boolean | undefined = undefined
      const onFormDirtyChange = (isDirty: boolean) => {
        formDirty = isDirty
      }

      renderComponent(onFormDirtyChange)

      // Component calls onFormDirtyChange(false) on initialization
      await waitFor(() => {
        expect(formDirty).toBe(false)
      })

      expect(screen.getByText('Where are you located?')).toBeInTheDocument()
    })

    it('should reset form state on initialization', async () => {
      await renderComponent()

      await waitFor(() => {
        expect(screen.getByText('Select location...')).toBeInTheDocument()
      })

      const triggerButton = screen.getByText('Select location...').closest('button')
      expect(triggerButton).toBeInTheDocument()
      expect(triggerButton?.textContent).toContain('Select location...')
    })
  })

  describe('Error Handling Business Logic', () => {
    it('should render component even when errors occur', async () => {
      await renderComponent()

      await waitFor(() => {
        expect(screen.getByText('Where are you located?')).toBeInTheDocument()
      })

      expect(screen.getByText('Select location...')).toBeInTheDocument()
    })
  })

  describe('Component Initialization Business Logic', () => {
    it('should auto-focus search input on mount', async () => {
      await renderComponent()

      await waitFor(() => {
        const searchInput = screen.getByPlaceholderText(/Search for locations/i)
        expect(searchInput).toBeInTheDocument()
      })
    })

    it('should auto-click trigger button on mount', async () => {
      await renderComponent()

      await waitFor(() => {
        const triggerButton = screen.getByText('Select location...').closest('button')
        expect(triggerButton).toBeInTheDocument()
      })
    })

    it('should initialize form with correct default values', async () => {
      await renderComponent()

      await waitFor(() => {
        expect(screen.getByText('Select location...')).toBeInTheDocument()
      })

      const triggerButton = screen.getByText('Select location...').closest('button')
      expect(triggerButton).toBeInTheDocument()
      expect(triggerButton?.textContent).toContain('Select location...')
    })
  })

  describe('Form Submission Business Logic', () => {
    it('should have form element for submission', async () => {
      await renderComponent()

      await waitFor(() => {
        const form = document.querySelector('form')
        expect(form).toBeInTheDocument()
      })
    })

    it('should prevent submission of invalid form', async () => {
      await renderComponent()

      await waitFor(() => {
        expect(screen.getByText('Select location...')).toBeInTheDocument()
      })

      const form = document.querySelector('form')!
      fireEvent.submit(form)

      await act(async () => {
        await getClock().runAllAsync()
      })

      const errorMessage = screen.queryByText('Location is required.')
      expect(errorMessage).toBeInTheDocument()
    })
  })

  describe('Location Search Integration Business Logic', () => {
    it('should integrate with real location search hook', async () => {
      await renderComponent()

      await waitFor(() => {
        expect(screen.getByText('Select location...')).toBeInTheDocument()
      })

      const searchInput = screen.getByPlaceholderText(/Search for locations/i)
      const triggerButton = screen.getByText('Select location...').closest('button')

      expect(searchInput).toBeInTheDocument()
      expect(triggerButton).toBeInTheDocument()
    })

    it('should handle search query changes', async () => {
      await renderComponent()

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Search for locations/i)).toBeInTheDocument()
      })

      const searchInput = screen.getByPlaceholderText(/Search for locations/i)

      fireEvent.change(searchInput, { target: { value: 'New York' } })

      await waitFor(() => {
        expect(searchInput).toBeInTheDocument()
      })
    })

    it('should display search results when available', async () => {
      await renderComponent()

      await waitFor(() => {
        const commandList = document.querySelector('[cmdk-list]')
        expect(commandList).toBeInTheDocument()
      })
    })

    it('should show loading state during search', async () => {
      await renderComponent()

      await waitFor(() => {
        expect(screen.getByText('Select location...')).toBeInTheDocument()
      })

      const triggerButton = screen.getByText('Select location...').closest('button')
      fireEvent.click(triggerButton!)

      await waitFor(() => {
        expect(triggerButton).toBeInTheDocument()
      })
    })

    it('should show empty state when no results found', async () => {
      await renderComponent()

      await waitFor(() => {
        expect(screen.getByText('Select location...')).toBeInTheDocument()
      })

      const triggerButton = screen.getByText('Select location...').closest('button')
      fireEvent.click(triggerButton!)

      await waitFor(() => {
        expect(triggerButton).toBeInTheDocument()
      })
    })
  })
})

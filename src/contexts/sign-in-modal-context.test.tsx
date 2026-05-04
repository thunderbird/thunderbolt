import { showSignInModalEvent, signInSuccessEvent } from '@/hooks/use-credential-events'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// Mock the heavy modal children — they each pull in auth/http/db contexts that aren't needed
// to verify the provider's listener wiring.
let capturedSignInModalOnSuccess: (() => void) | null = null
let capturedSignInModalOpen = false

mock.module('@/components/sign-in-modal', () => ({
  SignInModal: (props: { open: boolean; onOpenChange: (open: boolean) => void; onSuccess?: () => void }) => {
    capturedSignInModalOnSuccess = props.onSuccess ?? null
    capturedSignInModalOpen = props.open
    return null
  },
}))

mock.module('@/components/sync-setup/sync-setup-modal', () => ({
  SyncSetupModal: () => null,
}))

mock.module('@/db/powersync', () => ({
  setSyncEnabled: mock(() => Promise.resolve()),
}))

mock.module('@/db/encryption', () => ({
  needsSyncSetupWizard: mock(() => Promise.resolve(false)),
}))

mock.module('@/lib/posthog', () => ({
  trackError: mock(() => {}),
  trackEvent: mock(() => {}),
}))

// Import after mocks so the provider picks them up.
import { SignInModalProvider } from './sign-in-modal-context'

describe('SignInModalProvider', () => {
  beforeEach(() => {
    capturedSignInModalOnSuccess = null
    capturedSignInModalOpen = false
  })

  afterEach(() => {
    capturedSignInModalOnSuccess = null
  })

  it('opens the sign-in modal when showSignInModalEvent is dispatched', () => {
    render(
      <SignInModalProvider>
        <div />
      </SignInModalProvider>,
    )

    expect(capturedSignInModalOpen).toBe(false)

    act(() => {
      window.dispatchEvent(new CustomEvent(showSignInModalEvent))
    })

    expect(capturedSignInModalOpen).toBe(true)
  })

  it('dispatches signInSuccessEvent when sign-in completes', async () => {
    const successListener = mock()
    window.addEventListener(signInSuccessEvent, successListener)

    render(
      <SignInModalProvider>
        <div />
      </SignInModalProvider>,
    )

    expect(capturedSignInModalOnSuccess).not.toBeNull()

    await act(async () => {
      capturedSignInModalOnSuccess?.()
    })

    expect(successListener).toHaveBeenCalledTimes(1)

    window.removeEventListener(signInSuccessEvent, successListener)
  })

  it('removes the event listener on unmount', () => {
    const { unmount } = render(
      <SignInModalProvider>
        <div />
      </SignInModalProvider>,
    )

    unmount()

    // After unmount, dispatching should not throw or affect any state.
    act(() => {
      window.dispatchEvent(new CustomEvent(showSignInModalEvent))
    })

    expect(capturedSignInModalOpen).toBe(false)
  })
})

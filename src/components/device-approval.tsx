/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { AlertCircle, Loader2, ShieldQuestion, Terminal } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useReducer, useRef } from 'react'
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { GradientCheck } from '@/components/ui/gradient-check'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth, useSignInModal, type AuthClient } from '@/contexts'
import { saveDeviceApprovalReturn } from '@/lib/device-approval-return'
import {
  approveDeviceCode,
  denyDeviceCode,
  normalizeUserCode,
  verifyDeviceCode,
  type DeviceGrantFailure,
} from '@/lib/device-grant'

type Status = 'enteringCode' | 'verifying' | 'confirming' | 'submitting' | 'approved' | 'denied' | 'failed'

type State = {
  status: Status
  userCode: string
  pendingAction: 'approve' | 'deny' | null
  error: DeviceGrantFailure | null
}

type Action =
  | { type: 'CODE_CHANGED'; userCode: string }
  | { type: 'VERIFY_STARTED'; userCode: string }
  | { type: 'SETTLED'; status: 'confirming' | 'approved' | 'denied' }
  | { type: 'SUBMIT_STARTED'; action: 'approve' | 'deny' }
  | { type: 'FAILED'; error: DeviceGrantFailure }
  | { type: 'RESET' }

const init = (initialCode: string): State => ({
  status: initialCode ? 'verifying' : 'enteringCode',
  userCode: initialCode,
  pendingAction: null,
  error: null,
})

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'CODE_CHANGED':
      return { ...state, userCode: action.userCode }
    case 'VERIFY_STARTED':
      // Persist the canonical (normalized) code so approve/deny post exactly what was verified.
      return { ...state, status: 'verifying', userCode: action.userCode, error: null }
    case 'SETTLED':
      return { ...state, status: action.status, pendingAction: null }
    case 'SUBMIT_STARTED':
      return { ...state, status: 'submitting', pendingAction: action.action, error: null }
    case 'FAILED':
      return { ...state, status: 'failed', pendingAction: null, error: action.error }
    case 'RESET':
      return { status: 'enteringCode', userCode: '', pendingAction: null, error: null }
  }
}

/**
 * Drives the RFC 8628 approval flow: claim/verify the user code (which binds it to the
 * signed-in account), then approve or deny. Only mounts once the caller has a real account,
 * so the verify-on-mount effect always runs with a non-anonymous session.
 */
const useDeviceApproval = (authClient: AuthClient, initialCode: string) => {
  const [state, dispatch] = useReducer(reducer, initialCode, init)

  const verify = async (code: string) => {
    dispatch({ type: 'VERIFY_STARTED', userCode: code })
    const result = await verifyDeviceCode(authClient, code)
    if (!result.ok) {
      dispatch({ type: 'FAILED', error: result })
      return
    }
    dispatch({ type: 'SETTLED', status: result.status === 'pending' ? 'confirming' : result.status })
  }

  // Verify-on-mount when the code arrived via the QR/link. Ref-guarded so Strict Mode's
  // double invocation issues a single claim. The typed-code path verifies from its submit
  // handler instead, so no effect covers it.
  const verifiedRef = useRef(false)
  useEffect(() => {
    if (!initialCode || verifiedRef.current) {
      return
    }
    verifiedRef.current = true
    void verify(initialCode)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot claim keyed by the URL code
  }, [initialCode])

  const submitCode = (event: FormEvent) => {
    event.preventDefault()
    const code = normalizeUserCode(state.userCode)
    if (code) {
      void verify(code)
    }
  }

  const runAction = async (action: 'approve' | 'deny') => {
    dispatch({ type: 'SUBMIT_STARTED', action })
    const call = action === 'approve' ? approveDeviceCode : denyDeviceCode
    const result = await call(authClient, state.userCode)
    if (!result.ok) {
      dispatch({ type: 'FAILED', error: result })
      return
    }
    dispatch({ type: 'SETTLED', status: action === 'approve' ? 'approved' : 'denied' })
  }

  return {
    state,
    setCode: (userCode: string) => dispatch({ type: 'CODE_CHANGED', userCode }),
    submitCode,
    approve: () => runAction('approve'),
    deny: () => runAction('deny'),
    reset: () => dispatch({ type: 'RESET' }),
  }
}

const iconWrapperClass = 'mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full'

/** Non-dismissable modal shell shared by every approval-page state. */
const ApprovalShell = ({ children }: { children: ReactNode }) => (
  <Dialog open onOpenChange={() => {}}>
    <DialogContent className="sm:max-w-md" showCloseButton={false} onPointerDownOutside={(e) => e.preventDefault()}>
      {children}
    </DialogContent>
  </Dialog>
)

const DeviceApprovalContent = ({ initialCode }: { initialCode: string }) => {
  const authClient = useAuth()
  const navigate = useNavigate()
  const { state, setCode, submitCode, approve, deny, reset } = useDeviceApproval(authClient, initialCode)

  const goHome = () => navigate('/', { replace: true })
  const isSubmitting = state.status === 'submitting'

  return (
    <ApprovalShell>
      {state.status === 'verifying' && (
        <DialogHeader>
          <div className={`${iconWrapperClass} bg-gradient-to-br from-amber-400 to-orange-500`}>
            <Loader2 className="size-[var(--icon-size-default)] animate-spin text-white" />
          </div>
          <DialogTitle className="text-center text-xl">
            <Trans>Checking sign-in request…</Trans>
          </DialogTitle>
          <DialogDescription className="text-center">
            <Trans>One moment while we look up the code.</Trans>
          </DialogDescription>
        </DialogHeader>
      )}

      {state.status === 'enteringCode' && (
        <form onSubmit={submitCode}>
          <DialogHeader>
            <div className={`${iconWrapperClass} bg-muted`}>
              <Terminal className="size-[var(--icon-size-default)] text-muted-foreground" />
            </div>
            <DialogTitle className="text-center text-xl">
              <Trans>Sign in to the CLI</Trans>
            </DialogTitle>
            <DialogDescription className="text-center">
              <Trans>Enter the code shown in your terminal to continue.</Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="device-user-code">
              <Trans>Code</Trans>
            </Label>
            <Input
              id="device-user-code"
              autoFocus
              autoComplete="off"
              placeholder="ABCD-1234"
              value={state.userCode}
              onChange={(e) => setCode(e.target.value)}
              className="text-center font-mono tracking-[0.3em] uppercase"
            />
            <Button type="submit" className="mt-2 w-full" disabled={!normalizeUserCode(state.userCode)}>
              <Trans>Continue</Trans>
            </Button>
          </div>
        </form>
      )}

      {(state.status === 'confirming' || isSubmitting) && (
        <>
          <DialogHeader>
            <div className={`${iconWrapperClass} bg-gradient-to-br from-amber-400 to-orange-500`}>
              <ShieldQuestion className="size-[var(--icon-size-default)] text-white" />
            </div>
            <DialogTitle className="text-center text-xl">
              <Trans>Approve CLI sign-in?</Trans>
            </DialogTitle>
            <DialogDescription className="text-center">
              <Trans>
                A device wants to sign in to your account as the Thunderbolt CLI. Only approve if you just started this
                from your own terminal.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="rounded-lg bg-muted px-4 py-2 text-center font-mono text-lg tracking-[0.3em]">
              {state.userCode}
            </div>
            <p className="text-center text-[length:var(--font-size-sm)] text-muted-foreground">
              <Trans>Confirm this code matches the one in your terminal.</Trans>
            </p>
            <div className="flex w-full gap-2">
              <Button variant="outline" className="flex-1" onClick={deny} disabled={isSubmitting}>
                {state.pendingAction === 'deny' ? (
                  <Loader2 className="size-[var(--icon-size-sm)] animate-spin" />
                ) : (
                  <Trans>Deny</Trans>
                )}
              </Button>
              <Button className="flex-1" onClick={approve} disabled={isSubmitting}>
                {state.pendingAction === 'approve' ? (
                  <Loader2 className="size-[var(--icon-size-sm)] animate-spin" />
                ) : (
                  <Trans>Approve</Trans>
                )}
              </Button>
            </div>
          </div>
        </>
      )}

      {state.status === 'approved' && (
        <>
          <DialogHeader>
            <GradientCheck className="mx-auto mb-4 size-12" />
            <DialogTitle className="text-center text-xl">
              <Trans>Sign-in approved</Trans>
            </DialogTitle>
            <DialogDescription className="text-center">
              <Trans>You can return to your terminal.</Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Button className="w-full" onClick={goHome}>
              <Trans>Done</Trans>
            </Button>
          </div>
        </>
      )}

      {state.status === 'denied' && (
        <>
          <DialogHeader>
            <div className={`${iconWrapperClass} bg-muted`}>
              <AlertCircle className="size-[var(--icon-size-default)] text-muted-foreground" />
            </div>
            <DialogTitle className="text-center text-xl">
              <Trans>Sign-in denied</Trans>
            </DialogTitle>
            <DialogDescription className="text-center">
              <Trans>The request was denied. You can safely close this page.</Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Button variant="outline" className="w-full" onClick={goHome}>
              <Trans>Close</Trans>
            </Button>
          </div>
        </>
      )}

      {state.status === 'failed' && state.error && (
        <>
          <DialogHeader>
            <div className={`${iconWrapperClass} bg-red-100 dark:bg-red-900/30`}>
              <AlertCircle className="size-[var(--icon-size-default)] text-red-600 dark:text-red-400" />
            </div>
            <DialogTitle className="text-center text-xl">
              {state.error.reason === 'expired' ? <Trans>Request expired</Trans> : <Trans>Code didn't work</Trans>}
            </DialogTitle>
            <DialogDescription className="text-center">{state.error.message}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-4">
            <Button variant="outline" className="w-full" onClick={reset}>
              <Trans>Enter a different code</Trans>
            </Button>
            <Button variant="ghost" className="w-full" onClick={goHome}>
              <Trans>Close</Trans>
            </Button>
          </div>
        </>
      )}
    </ApprovalShell>
  )
}

/**
 * `/device` — device-authorization approval page (RFC 8628). The user lands here from the
 * CLI's verification link/QR (which embeds the `user_code`). Approval requires a signed-in
 * real account session. Unauthenticated visitors enter the normal auth flow with their return URL
 * stashed. Anonymous visitors stay on this URL and can open the real-account sign-in modal, avoiding
 * a redirect loop through the authenticated home route. Lazy-loaded (off the landing path).
 */
export const DeviceApproval = () => {
  const authClient = useAuth()
  const { openSignInModal } = useSignInModal()
  const { data: session, isPending } = authClient.useSession()
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const isAnonymous = !isPending && session?.user?.isAnonymous === true

  if (isPending) {
    return (
      <ApprovalShell>
        <DialogHeader>
          <div className={`${iconWrapperClass} bg-gradient-to-br from-amber-400 to-orange-500`}>
            <Loader2 className="size-[var(--icon-size-default)] animate-spin text-white" />
          </div>
          <DialogTitle className="text-center text-xl">
            <Trans>Loading…</Trans>
          </DialogTitle>
          <DialogDescription className="text-center">
            <Trans>Checking your session.</Trans>
          </DialogDescription>
        </DialogHeader>
      </ApprovalShell>
    )
  }

  if (!session?.user) {
    // Preserve the code across the login redirect so the approval page comes back pre-filled.
    // Render-phase storage write: idempotent (same key, same value), so Strict Mode's double
    // render is harmless, and it must happen before the <Navigate> below unmounts this page.
    if (searchParams.get('user_code')) {
      saveDeviceApprovalReturn(`${location.pathname}${location.search}`)
    }
    return <Navigate to="/" replace />
  }

  if (isAnonymous) {
    return (
      <ApprovalShell>
        <DialogHeader>
          <div className={`${iconWrapperClass} bg-muted`}>
            <Terminal className="size-[var(--icon-size-default)] text-muted-foreground" />
          </div>
          <DialogTitle className="text-center text-xl">
            <Trans>Sign in to continue</Trans>
          </DialogTitle>
          <DialogDescription className="text-center">
            <Trans>Sign in to a Thunderbolt account to approve this CLI request.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <Button className="w-full" onClick={openSignInModal}>
            <Trans>Sign in</Trans>
          </Button>
        </div>
      </ApprovalShell>
    )
  }

  // `key` remounts (fresh reducer + re-verify) if the URL's user_code changes while mounted,
  // so a new code can never be approved against state initialized from the previous one.
  const code = normalizeUserCode(searchParams.get('user_code') ?? '')
  return <DeviceApprovalContent key={code} initialCode={code} />
}

export default DeviceApproval

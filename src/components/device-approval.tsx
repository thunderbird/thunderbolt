/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AlertCircle, Loader2, ShieldQuestion, Terminal } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useReducer, useRef } from 'react'
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { GradientCheck } from '@/components/ui/gradient-check'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth, type AuthClient } from '@/contexts'
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
  | { type: 'setCode'; userCode: string }
  | { type: 'verifyStart'; userCode: string }
  | { type: 'settled'; status: 'confirming' | 'approved' | 'denied' }
  | { type: 'submitStart'; action: 'approve' | 'deny' }
  | { type: 'fail'; error: DeviceGrantFailure }
  | { type: 'reset' }

const init = (initialCode: string): State => ({
  status: initialCode ? 'verifying' : 'enteringCode',
  userCode: initialCode,
  pendingAction: null,
  error: null,
})

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'setCode':
      return { ...state, userCode: action.userCode }
    case 'verifyStart':
      // Persist the canonical (normalized) code so approve/deny post exactly what was verified.
      return { ...state, status: 'verifying', userCode: action.userCode, error: null }
    case 'settled':
      return { ...state, status: action.status, pendingAction: null }
    case 'submitStart':
      return { ...state, status: 'submitting', pendingAction: action.action, error: null }
    case 'fail':
      return { ...state, status: 'failed', pendingAction: null, error: action.error }
    case 'reset':
      return { status: 'enteringCode', userCode: '', pendingAction: null, error: null }
  }
}

/**
 * Drives the RFC 8628 approval flow: claim/verify the user code (which binds it to the
 * signed-in account), then approve or deny. Only mounts once the caller is authenticated,
 * so the verify-on-mount effect always runs with a session.
 */
const useDeviceApproval = (authClient: AuthClient, initialCode: string) => {
  const [state, dispatch] = useReducer(reducer, initialCode, init)

  const verify = async (code: string) => {
    dispatch({ type: 'verifyStart', userCode: code })
    const result = await verifyDeviceCode(authClient, code)
    if (!result.ok) {
      dispatch({ type: 'fail', error: result })
      return
    }
    dispatch({ type: 'settled', status: result.status === 'pending' ? 'confirming' : result.status })
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
    dispatch({ type: 'submitStart', action })
    const call = action === 'approve' ? approveDeviceCode : denyDeviceCode
    const result = await call(authClient, state.userCode)
    if (!result.ok) {
      dispatch({ type: 'fail', error: result })
      return
    }
    dispatch({ type: 'settled', status: action === 'approve' ? 'approved' : 'denied' })
  }

  return {
    state,
    setCode: (userCode: string) => dispatch({ type: 'setCode', userCode }),
    submitCode,
    approve: () => runAction('approve'),
    deny: () => runAction('deny'),
    reset: () => dispatch({ type: 'reset' }),
  }
}

const iconWrapper = 'mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full'

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
          <div className={`${iconWrapper} bg-gradient-to-br from-amber-400 to-orange-500`}>
            <Loader2 className="size-[var(--icon-size-default)] animate-spin text-white" />
          </div>
          <DialogTitle className="text-center text-xl">Checking sign-in request…</DialogTitle>
          <DialogDescription className="text-center">One moment while we look up the code.</DialogDescription>
        </DialogHeader>
      )}

      {state.status === 'enteringCode' && (
        <form onSubmit={submitCode}>
          <DialogHeader>
            <div className={`${iconWrapper} bg-muted`}>
              <Terminal className="size-[var(--icon-size-default)] text-muted-foreground" />
            </div>
            <DialogTitle className="text-center text-xl">Sign in to the CLI</DialogTitle>
            <DialogDescription className="text-center">
              Enter the code shown in your terminal to continue.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="device-user-code">Code</Label>
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
              Continue
            </Button>
          </div>
        </form>
      )}

      {(state.status === 'confirming' || isSubmitting) && (
        <>
          <DialogHeader>
            <div className={`${iconWrapper} bg-gradient-to-br from-amber-400 to-orange-500`}>
              <ShieldQuestion className="size-[var(--icon-size-default)] text-white" />
            </div>
            <DialogTitle className="text-center text-xl">Approve CLI sign-in?</DialogTitle>
            <DialogDescription className="text-center">
              A device wants to sign in to your account as the Thunderbolt CLI. Only approve if you just started this
              from your own terminal.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="rounded-lg bg-muted px-4 py-2 text-center font-mono text-lg tracking-[0.3em]">
              {state.userCode}
            </div>
            <p className="text-center text-[length:var(--font-size-sm)] text-muted-foreground">
              Confirm this code matches the one in your terminal.
            </p>
            <div className="flex w-full gap-2">
              <Button variant="outline" className="flex-1" onClick={deny} disabled={isSubmitting}>
                {state.pendingAction === 'deny' ? (
                  <Loader2 className="size-[var(--icon-size-sm)] animate-spin" />
                ) : (
                  'Deny'
                )}
              </Button>
              <Button className="flex-1" onClick={approve} disabled={isSubmitting}>
                {state.pendingAction === 'approve' ? (
                  <Loader2 className="size-[var(--icon-size-sm)] animate-spin" />
                ) : (
                  'Approve'
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
            <DialogTitle className="text-center text-xl">Sign-in approved</DialogTitle>
            <DialogDescription className="text-center">You can return to your terminal.</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Button className="w-full" onClick={goHome}>
              Done
            </Button>
          </div>
        </>
      )}

      {state.status === 'denied' && (
        <>
          <DialogHeader>
            <div className={`${iconWrapper} bg-muted`}>
              <AlertCircle className="size-[var(--icon-size-default)] text-muted-foreground" />
            </div>
            <DialogTitle className="text-center text-xl">Sign-in denied</DialogTitle>
            <DialogDescription className="text-center">
              The request was denied. You can safely close this page.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Button variant="outline" className="w-full" onClick={goHome}>
              Close
            </Button>
          </div>
        </>
      )}

      {state.status === 'failed' && state.error && (
        <>
          <DialogHeader>
            <div className={`${iconWrapper} bg-red-100 dark:bg-red-900/30`}>
              <AlertCircle className="size-[var(--icon-size-default)] text-red-600 dark:text-red-400" />
            </div>
            <DialogTitle className="text-center text-xl">
              {state.error.reason === 'expired' ? 'Request expired' : "Code didn't work"}
            </DialogTitle>
            <DialogDescription className="text-center">{state.error.message}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-4">
            <Button variant="outline" className="w-full" onClick={reset}>
              Enter a different code
            </Button>
            <Button variant="ghost" className="w-full" onClick={goHome}>
              Close
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
 * session; unauthenticated visitors are sent into the normal auth flow with their return URL
 * stashed, so the page replays pre-filled once they land back authenticated (see
 * `device-approval-return.ts`) — no link re-open needed. Lazy-loaded (off the landing path).
 */
export const DeviceApproval = () => {
  const authClient = useAuth()
  const { data: session, isPending } = authClient.useSession()
  const [searchParams] = useSearchParams()
  const location = useLocation()

  if (isPending) {
    return (
      <ApprovalShell>
        <DialogHeader>
          <div className={`${iconWrapper} bg-gradient-to-br from-amber-400 to-orange-500`}>
            <Loader2 className="size-[var(--icon-size-default)] animate-spin text-white" />
          </div>
          <DialogTitle className="text-center text-xl">Loading…</DialogTitle>
          <DialogDescription className="text-center">Checking your session.</DialogDescription>
        </DialogHeader>
      </ApprovalShell>
    )
  }

  if (!session?.user) {
    // Preserve the code across the login redirect so the approval page comes back pre-filled.
    if (searchParams.get('user_code')) {
      saveDeviceApprovalReturn(`${location.pathname}${location.search}`)
    }
    return <Navigate to="/" replace />
  }

  // `key` remounts (fresh reducer + re-verify) if the URL's user_code changes while mounted,
  // so a new code can never be approved against state initialized from the previous one.
  const code = normalizeUserCode(searchParams.get('user_code') ?? '')
  return <DeviceApprovalContent key={code} initialCode={code} />
}

export default DeviceApproval

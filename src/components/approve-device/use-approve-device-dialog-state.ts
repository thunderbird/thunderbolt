/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { challengeApprovalSession, fetchPendingApprovalSession } from '@/api/encryption'
import { useHttpClient } from '@/contexts'
import {
  type ApprovalCodeConfirmation,
  createApprovalCodeOptions,
  createApprovalNonce,
} from '@/crypto/device-approval-code'
import { DeviceApprovalError } from '@/crypto/errors'
import { HttpError } from '@/lib/http'
import { deriveCodeForPendingDevice, type DeviceApprovalConfirmation } from '@/services/encryption'
import { useEffect, useEffectEvent, useReducer, useRef } from 'react'
import { canUseApprovalCode, forgiveApprovalCodeAttempt, startApprovalCodeAttempt } from './approval-code-attempts'

export type PendingDeviceKeys = { id: string; publicKey: string; mlkemPublicKey: string }

type ApproveDeviceDialogStep =
  | { step: 'connecting' }
  | { step: 'pick'; options: string[]; confirmation: ApprovalCodeConfirmation }
  | { step: 'unavailable' }
  /** The codes did not match: a wrong tap, "None of these match", or a reveal that broke its commitment. */
  | { step: 'mismatch' }
  | { step: 'fingerprint'; reason: 'chosen' | 'limit' }

/** A failure `onConfirm` reported for a correctly picked code; the user can tap it again. */
type ApproveSubmitError = 'conflict' | 'generic'

type State = ApproveDeviceDialogStep & { submitError: ApproveSubmitError | null }

type Action = { type: 'go'; to: ApproveDeviceDialogStep } | { type: 'submit-failed'; error: ApproveSubmitError }

const reducer = (state: State, action: Action): State =>
  action.type === 'go' ? { ...action.to, submitError: null } : { ...state, submitError: action.error }

const initialStep = (): State =>
  canUseApprovalCode()
    ? { step: 'connecting', submitError: null }
    : { step: 'fingerprint', reason: 'limit', submitError: null }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const pollMs = 1500
/** How long the trusted device waits for the new device to reveal before calling the attempt failed. */
const revealTimeoutMs = 60_000

type UseApproveDeviceDialogStateOptions = {
  device: { id: string; publicKey: string | null; mlkemPublicKey: string | null } | null
  onConfirm: (confirmation: DeviceApprovalConfirmation) => void | Promise<void>
  /** Injected in tests; production derives with this account and this device as the challenger. */
  deriveCode?: typeof deriveCodeForPendingDevice
}

/**
 * The trusted device's side of the short-code approval: send a challenge as soon as the dialog
 * opens, wait for the reveal, verify the commitment, offer six codes. The pending device's keys are
 * frozen when the attempt starts. Later changes to the served row never reach it.
 */
export const useApproveDeviceDialogState = ({
  device,
  onConfirm,
  deriveCode = deriveCodeForPendingDevice,
}: UseApproveDeviceDialogStateOptions) => {
  const httpClient = useHttpClient()
  const [state, dispatch] = useReducer(reducer, undefined, initialStep)
  /** Bumped by every new attempt and on unmount, so a superseded attempt stops at its next await. */
  const attemptToken = useRef(0)
  const attemptStartedAt = useRef<number | null>(null)

  const go = (to: ApproveDeviceDialogStep) => dispatch({ type: 'go', to })

  /**
   * Wait for the reveal on the frozen session; null on timeout or when superseded. The deadline is
   * re-checked after every response, so a server holding a request cannot stretch the attempt.
   */
  const waitForReveal = async (target: PendingDeviceKeys, sessionId: string, isCurrent: () => boolean) => {
    const deadline = Date.now() + revealTimeoutMs
    while (Date.now() < deadline) {
      await sleep(pollMs)
      if (!isCurrent()) {
        return null
      }
      const row = await fetchPendingApprovalSession(httpClient, target.id).catch(() => null)
      if (Date.now() >= deadline) {
        return null
      }
      if (row?.sessionId === sessionId && row.reveal && !row.expired) {
        return row.reveal
      }
    }
    return null
  }

  const runAttempt = async (target: PendingDeviceKeys) => {
    const token = ++attemptToken.current
    const isCurrent = () => attemptToken.current === token
    go({ step: 'connecting' })
    const session = await fetchPendingApprovalSession(httpClient, target.id).catch(() => null)
    if (!isCurrent()) {
      return
    }
    if (!session || session.expired) {
      go({ step: 'unavailable' })
      return
    }
    const { sessionId, commitment } = session
    const challenge = createApprovalNonce()
    const sent = await challengeApprovalSession(httpClient, target.id, { sessionId, challenge }).then(
      () => true,
      () => false,
    )
    if (!isCurrent()) {
      return
    }
    if (!sent) {
      go({ step: 'unavailable' })
      return
    }
    // Counted once the server takes the challenge, and before any code is shown: a refused challenge
    // (an attempt the new device already spent) shows nothing to guess at, so it costs nothing.
    const startedAt = startApprovalCodeAttempt()
    if (startedAt === null) {
      go({ step: 'fingerprint', reason: 'limit' })
      return
    }
    attemptStartedAt.current = startedAt
    const reveal = await waitForReveal(target, sessionId, isCurrent)
    if (!isCurrent()) {
      return
    }
    // No reveal in time: the new device is not taking part, which is not a mismatch.
    if (!reveal) {
      go({ step: 'unavailable' })
      return
    }
    const code = await deriveCode(target, { sessionId, commitment, challenge, reveal })
    if (!isCurrent()) {
      return
    }
    if (!code) {
      go({ step: 'mismatch' })
      return
    }
    go({
      step: 'pick',
      options: createApprovalCodeOptions(code),
      confirmation: { sessionId, commitment, challenge, reveal, code },
    })
  }

  /** Opening the dialog and "Try again": re-check the local cap before every attempt. */
  const start = () => {
    if (!canUseApprovalCode()) {
      go({ step: 'fingerprint', reason: 'limit' })
      return
    }
    if (!device?.publicKey || !device.mlkemPublicKey) {
      go({ step: 'unavailable' })
      return
    }
    void runAttempt({ id: device.id, publicKey: device.publicKey, mlkemPublicKey: device.mlkemPublicKey })
  }

  const startOnOpen = useEffectEvent(start)
  // Legitimate useEffect: the attempt is an async operation on mount, cancelled when the dialog closes.
  useEffect(() => {
    startOnOpen()
    return () => {
      attemptToken.current += 1
    }
  }, [])

  const pick = async (option: string) => {
    if (state.step !== 'pick') {
      return
    }
    const { confirmation } = state
    if (option !== confirmation.code) {
      go({ step: 'mismatch' })
      return
    }
    try {
      await onConfirm({ kind: 'code', ...confirmation })
      if (attemptStartedAt.current !== null) {
        forgiveApprovalCodeAttempt(attemptStartedAt.current)
        attemptStartedAt.current = null
      }
    } catch (error) {
      if (error instanceof DeviceApprovalError && error.reason === 'code-mismatch') {
        go({ step: 'mismatch' })
        return
      }
      if (!(error instanceof HttpError && error.response.status === 409)) {
        console.error('Failed to approve device.')
      }
      dispatch({
        type: 'submit-failed',
        error: error instanceof HttpError && error.response.status === 409 ? 'conflict' : 'generic',
      })
    }
  }

  return {
    state,
    start,
    pick,
    noneMatch: () => go({ step: 'mismatch' }),
    chooseFingerprint: () => {
      attemptToken.current += 1
      go({ step: 'fingerprint', reason: 'chosen' })
    },
  }
}

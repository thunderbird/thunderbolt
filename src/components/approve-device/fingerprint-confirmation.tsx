/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { normalizeDeviceApprovalFingerprint } from '@/crypto/device-approval-fingerprint'
import { DeviceApprovalError } from '@/crypto/errors'
import { HttpError } from '@/lib/http'
import type { DeviceApprovalConfirmation } from '@/services/encryption'
import { useId, useRef, useState } from 'react'

type FingerprintConfirmationProps = {
  canConfirm: boolean
  onConfirm: (confirmation: DeviceApprovalConfirmation) => void | Promise<void>
  isPending: boolean
  /** Set when too many codes failed on this device today, so the code path is off. */
  limitReached: boolean
}

/** Typing the full 64-hex fingerprint: the fallback for older peers and after too many missed codes. */
export const FingerprintConfirmation = ({
  canConfirm,
  onConfirm,
  isPending,
  limitReached,
}: FingerprintConfirmationProps) => {
  const { t } = useLingui()
  const [fingerprint, setFingerprint] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const inputId = useId()
  const submitting = useRef(false)
  const isComplete = normalizeDeviceApprovalFingerprint(fingerprint) !== ''
  const confirm = async () => {
    if (submitting.current || isPending || !canConfirm || !isComplete) {
      return
    }
    submitting.current = true
    setSubmitError(null)
    try {
      await onConfirm({ kind: 'fingerprint', fingerprint })
    } catch (error) {
      if (error instanceof DeviceApprovalError && error.reason === 'fingerprint-mismatch') {
        setSubmitError(t`The fingerprint doesn't match. Check the fingerprint shown on the new device and try again.`)
      } else if (error instanceof HttpError && error.response.status === 409) {
        setSubmitError(t`Couldn't complete approval. Close this dialog and check the device list before trying again.`)
      } else {
        console.error('Failed to approve device.')
        setSubmitError(t`Couldn't approve this device. Please try again.`)
      }
    } finally {
      submitting.current = false
    }
  }
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>
          <Trans>Approve this device?</Trans>
        </AlertDialogTitle>
        <AlertDialogDescription>
          <Trans>This will share your encryption key with the device, allowing it to decrypt and sync your data.</Trans>
        </AlertDialogDescription>
      </AlertDialogHeader>
      {limitReached && (
        <p className="text-sm text-muted-foreground">
          <Trans>Too many codes didn't match on this device today, so approve with the fingerprint instead.</Trans>
        </p>
      )}
      <div className="space-y-2">
        <Label htmlFor={inputId}>
          <Trans>Device fingerprint</Trans>
        </Label>
        <p className="text-sm text-muted-foreground">
          <Trans>Enter the fingerprint from the new device's screen or a separate channel you trust.</Trans>
        </p>
        <Input
          id={inputId}
          value={fingerprint}
          onChange={(event) => setFingerprint(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={isPending}
          className="font-mono"
        />
      </div>
      {submitError && (
        <p className="text-[length:var(--font-size-sm)] text-destructive" role="alert">
          {submitError}
        </p>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={isPending}>
          <Trans>Cancel</Trans>
        </AlertDialogCancel>
        {/*
          AlertDialogAction closes regardless of the async result. The caller
          closes this dialog only after its approval mutation succeeds, so a
          rejected confirmation keeps the retry available.
        */}
        <Button
          onClick={confirm}
          disabled={isPending || !canConfirm || !isComplete}
          isLoading={isPending}
          loadingLabel={t`Approving…`}
        >
          <Trans>Approve</Trans>
        </Button>
      </AlertDialogFooter>
    </>
  )
}

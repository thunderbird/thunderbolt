/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { TriangleAlert } from 'lucide-react'
import { useId } from 'react'
import { DetailPanel } from '@/components/detail-panel'
import { DetailField } from '@/components/settings/detail-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Invitation } from '@shared/admin-api'
import { InlineError } from '../members/inline-error'
import { useInvitePanelState } from './use-invite-panel-state'

type InvitePanelProps = {
  onClose: () => void
  onInvited: (invitation: Invitation) => void
  onDirtyChange: (dirty: boolean) => void
}

/** Invite one address by email. The link in the email signs them in and makes them a member. */
export const InvitePanel = ({ onClose, onInvited, onDirtyChange }: InvitePanelProps) => {
  const { t } = useLingui()
  const emailId = useId()
  const state = useInvitePanelState(onInvited)

  return (
    <DetailPanel title={t`Invite member`} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          state.invite()
        }}
      >
        <DetailField
          label={
            <Label htmlFor={emailId}>
              <Trans>Email</Trans>
            </Label>
          }
        >
          <Input
            id={emailId}
            type="email"
            value={state.email}
            required
            maxLength={320}
            onChange={(event) => {
              state.setEmail(event.target.value)
              onDirtyChange(event.target.value.trim() !== '')
            }}
          />
        </DetailField>
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          <Trans>
            They get an email with a link that signs them in. Inviting the same address again replaces the earlier link.
          </Trans>
        </p>
        <InlineError error={state.error} />
        {state.claimedByIdp && (
          <Alert>
            <TriangleAlert />
            <AlertTitle>
              <Trans>An identity provider manages this domain</Trans>
            </AlertTitle>
            <AlertDescription>
              <p>
                <Trans>
                  People on this domain normally sign in through your identity provider. You can still invite this
                  address; the override is recorded in the audit log.
                </Trans>
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                isLoading={state.isPending}
                onClick={state.inviteAnyway}
              >
                <Trans>Invite anyway</Trans>
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {!state.claimedByIdp && (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" size="sm" disabled={!state.email.trim()} isLoading={state.isPending}>
              <Trans>Send invitation</Trans>
            </Button>
          </div>
        )}
      </form>
    </DetailPanel>
  )
}

/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { TriangleAlert } from 'lucide-react'
import { useId } from 'react'
import { DetailPanel } from '@/components/detail-panel'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'
import type { Invitation } from '@shared/admin-api'
import { InlineError } from '../../components/inline-error'
import { useInvitePanelState } from './use-invite-panel-state'
import { FormField } from '../../components/form-field'
import { useAutofocusOnMount } from '@/hooks/use-autofocus-on-mount'

type InvitePanelProps = {
  onClose: () => void
  onInvited: (invitation: Invitation) => void
  onDirtyChange: (dirty: boolean) => void
}

/** Invite one address by email. The link in the email signs them in and makes them a member. */
export const InvitePanel = ({ onClose, onInvited, onDirtyChange }: InvitePanelProps) => {
  const { t } = useLingui()
  const emailId = useId()
  const emailRef = useAutofocusOnMount<HTMLInputElement>(true)
  const state = useInvitePanelState(onInvited)

  return (
    <DetailPanel title={t`Invite Member`} onClose={onClose}>
      <form
        className="flex flex-1 flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          state.invite()
        }}
      >
        <FormField id={emailId} label={<Trans>Email</Trans>}>
          <Input
            id={emailId}
            ref={emailRef}
            type="email"
            value={state.email}
            required
            maxLength={320}
            placeholder={t`name@example.com`}
            className="md:h-9"
            onChange={(event) => {
              state.setEmail(event.target.value)
              onDirtyChange(event.target.value.trim() !== '')
            }}
          />
        </FormField>
        {state.claimedByIdp && (
          <Alert>
            <TriangleAlert />
            <AlertTitle>
              <Trans>An identity provider manages this domain</Trans>
            </AlertTitle>
            <AlertDescription>
              <p>
                <Trans>You can still invite this address. The audit log records it.</Trans>
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
        {/* While the domain alert is up, its "Invite anyway" is how this address gets sent. */}
        <FormFooter>
          <InlineError error={state.error} className="min-w-0 flex-1 truncate" />
          <ResponsiveModalCancel onClick={onClose} className="dark:hover:bg-accent" />
          <Button
            type="submit"
            disabled={!state.email.trim() || state.claimedByIdp}
            isLoading={state.isPending && !state.claimedByIdp}
            loadingLabel={t`Inviting…`}
          >
            <Trans>Invite</Trans>
          </Button>
        </FormFooter>
      </form>
    </DetailPanel>
  )
}

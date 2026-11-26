/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { Globe, KeyRound, type LucideIcon } from 'lucide-react'
import { DetailPanel } from '@/components/detail-panel'
import { Button } from '@/components/ui/button'
import { DiscardCreateDialog } from '@/skills/discard-create-dialog'
import { NewScimConnectionForm } from './new-scim-connection-form'
import { SsoConnectionForm } from './sso-connection-form'
import { type ConnectionKind, useNewConnectionEditorState } from './use-new-connection-editor-state'
import type { PanelDirt } from '../../components/use-resource-page-state'

const kinds: { id: ConnectionKind; label: MessageDescriptor; title: MessageDescriptor }[] = [
  { id: 'oidc', label: msg`OIDC single sign-on`, title: msg`New OIDC Connection` },
  { id: 'saml', label: msg`SAML single sign-on`, title: msg`New SAML Connection` },
  { id: 'scim', label: msg`SCIM provisioning`, title: msg`New SCIM Connection` },
]

/** One choice in the picker, styled as the Connections picker's options. */
const PickerOption = ({ icon: Icon, label, onSelect }: { icon: LucideIcon; label: string; onSelect: () => void }) => (
  <Button type="button" variant="outline" className="justify-start whitespace-normal text-left" onClick={onSelect}>
    <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center">
      <Icon className="size-4" />
    </span>
    <span className="flex-1 text-left">{label}</span>
  </Button>
)

type NewConnectionEditorProps = {
  onClose: () => void
  /** Adding a domain was picked instead: open its form. */
  onAddDomain: () => void
  /** The connection was created: open it. */
  onCreated: (connectionId: string) => void
  onDirty: (dirty: PanelDirt) => void
}

/**
 * The `new` panel: pick a connection's kind (or a domain), then fill in its form. The form's Back
 * returns to the picker, asking first when it holds unsaved input.
 */
export const NewConnectionEditor = ({ onClose, onAddDomain, onCreated, onDirty }: NewConnectionEditorProps) => {
  const { t, i18n } = useLingui()
  const { kind, confirmingBack, pick, trackDirty, requestBack, cancelBack, confirmBack } =
    useNewConnectionEditorState(onDirty)
  const picked = kinds.find((item) => item.id === kind)

  return (
    <DetailPanel title={picked ? i18n._(picked.title) : t`New Sign-in Method`} onClose={onClose}>
      {kind === null ? (
        <div className="flex flex-col gap-2">
          {kinds.map((item) => (
            <PickerOption key={item.id} icon={KeyRound} label={i18n._(item.label)} onSelect={() => pick(item.id)} />
          ))}
          <PickerOption icon={Globe} label={t`Domain`} onSelect={onAddDomain} />
        </div>
      ) : kind === 'scim' ? (
        <NewScimConnectionForm onCreated={onCreated} onCancel={onClose} onBack={requestBack} onDirty={trackDirty} />
      ) : (
        <SsoConnectionForm
          protocol={kind}
          onCreated={(connection) => onCreated(connection.id)}
          onCancel={onClose}
          onBack={requestBack}
          onDirty={trackDirty}
        />
      )}
      <DiscardCreateDialog
        open={confirmingBack}
        onOpenChange={(open) => !open && cancelBack()}
        onConfirm={confirmBack}
      />
    </DetailPanel>
  )
}

/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { DetailPanel } from '@/components/detail-panel'
import { SettingsSelectableRow } from '@/components/settings/settings-list'
import { NewScimConnectionForm } from './new-scim-connection-form'
import { SsoConnectionForm } from './sso-connection-form'

type ConnectionKind = 'oidc' | 'saml' | 'scim'

const kinds: { id: ConnectionKind; title: MessageDescriptor; description: MessageDescriptor }[] = [
  { id: 'oidc', title: msg`Single sign-on with OIDC`, description: msg`Entra ID, Okta, Keycloak and most providers.` },
  { id: 'saml', title: msg`Single sign-on with SAML`, description: msg`For providers that only offer SAML 2.0.` },
  {
    id: 'scim',
    title: msg`SCIM provisioning only`,
    description: msg`Your identity provider creates and updates people. You can add sign-in later.`,
  },
]

type NewConnectionEditorProps = {
  onClose: () => void
  /** The connection was created: open it. */
  onCreated: (connectionId: string) => void
  onDirty: (dirty: boolean) => void
}

/** The `?edit=new` panel: pick what the connection does, then fill in its form. */
export const NewConnectionEditor = ({ onClose, onCreated, onDirty }: NewConnectionEditorProps) => {
  const { t, i18n } = useLingui()
  const [kind, setKind] = useState<ConnectionKind | null>(null)

  return (
    <DetailPanel title={t`New connection`} onClose={onClose}>
      {kind === null ? (
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground">
            <Trans>What should this identity provider do?</Trans>
          </p>
          {kinds.map((item) => (
            <SettingsSelectableRow
              key={item.id}
              title={i18n._(item.title)}
              subtitle={i18n._(item.description)}
              ariaLabel={i18n._(item.title)}
              onSelect={() => setKind(item.id)}
            />
          ))}
        </div>
      ) : kind === 'scim' ? (
        <NewScimConnectionForm onCreated={onCreated} onCancel={onClose} onDirty={onDirty} />
      ) : (
        <SsoConnectionForm
          protocol={kind}
          onCreated={(connection) => onCreated(connection.id)}
          onCancel={onClose}
          onDirty={onDirty}
        />
      )}
    </DetailPanel>
  )
}

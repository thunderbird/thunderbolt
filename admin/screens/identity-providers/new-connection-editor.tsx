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
  /** Adding a domain was picked instead: open its form. */
  onAddDomain: () => void
  /** The connection was created: open it. */
  onCreated: (connectionId: string) => void
  onDirty: (dirty: boolean) => void
}

/** The `?edit=new` panel: pick a connection's kind (or a domain), then fill in its form. */
export const NewConnectionEditor = ({ onClose, onAddDomain, onCreated, onDirty }: NewConnectionEditorProps) => {
  const { t, i18n } = useLingui()
  const [kind, setKind] = useState<ConnectionKind | null>(null)

  return (
    <DetailPanel title={t`Add a sign-in method`} onClose={onClose}>
      {kind === null ? (
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground">
            <Trans>Connect an identity provider, or add a domain your organization owns.</Trans>
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
          <SettingsSelectableRow
            title={t`Domain`}
            subtitle={t`Verify a domain you own, then let people on it join or send them to an identity provider.`}
            ariaLabel={t`Domain`}
            onSelect={onAddDomain}
          />
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

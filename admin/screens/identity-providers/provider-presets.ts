/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { SsoProtocol } from '@shared/admin-api'

export type ProviderPreset = 'entra' | 'okta' | 'keycloak' | 'other'

export const providerPresets: { id: ProviderPreset; label: MessageDescriptor }[] = [
  { id: 'entra', label: msg`Microsoft Entra ID` },
  { id: 'okta', label: msg`Okta` },
  { id: 'keycloak', label: msg`Keycloak` },
  { id: 'other', label: msg`Other` },
]

/** Entra names its SAML attributes by the full claim URI, and they match exactly. */
const entraSamlObjectId = 'http://schemas.microsoft.com/identity/claims/objectidentifier'

const matchClaims: Record<ProviderPreset, Record<SsoProtocol, string>> = {
  entra: { oidc: 'oid', saml: entraSamlObjectId },
  okta: { oidc: 'sub', saml: 'sub' },
  // Under SAML, Keycloak needs a mapper for the user id, whose name the admin chooses.
  keycloak: { oidc: 'sub', saml: '' },
  other: { oidc: 'sub', saml: '' },
}

/**
 * The claim (OIDC) or attribute (SAML) whose value is the provider's SCIM `externalId`, as
 * `docs/self-hosting/provisioning.md` documents it per provider. Blank when the admin must name it.
 */
export const presetMatchClaim = (preset: ProviderPreset, protocol: SsoProtocol) => matchClaims[preset][protocol]

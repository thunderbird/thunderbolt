/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

/** The `?edit=` value of the "add a sign-in method" panel. */
export const newSignInMethodId = 'new'

/** The `?edit=` value of the add-domain form, reached from the "add" panel. */
export const newDomainId = 'new-domain'

/** The `?edit=` value (and remove id) that opens a connection on Sign-in methods. */
export const connectionEditId = (connectionId: string) => `connection:${connectionId}`

/** The `?edit=` value (and remove id) that opens a domain on Sign-in methods. */
export const domainEditId = (domainId: string) => `domain:${domainId}`

/** What an `?edit=` or remove id names: a connection or a domain, by id. Null for anything else. */
export const parseSignInMethodId = (value: string | null): { kind: 'connection' | 'domain'; id: string } | null => {
  const [kind, ...rest] = value?.split(':') ?? []
  const id = rest.join(':')
  return (kind === 'connection' || kind === 'domain') && id ? { kind, id } : null
}

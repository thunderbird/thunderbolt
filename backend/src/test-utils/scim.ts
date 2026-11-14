/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Helpers for replaying provider SCIM traffic in tests. */

export const scimBaseUrl = 'http://localhost/v1/api/auth/scim/v2'
export const scimUserSchema = 'urn:ietf:params:scim:schemas:core:2.0:User'
export const scimEnterpriseSchema = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'
export const scimGroupSchema = 'urn:ietf:params:scim:schemas:core:2.0:Group'
export const scimPatchSchema = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
export const entraLegacyGroupSchema = 'http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/2.0/Group'

export type ScimBody = Record<string, unknown> & {
  id?: string
  externalId?: string
  userName?: string
  emails?: { value: string; type?: string; primary?: boolean }[]
  members?: { value: string }[]
  Resources?: ScimBody[]
  totalResults?: number
  detail?: string
  scimType?: string
  status?: string
  schemas?: string[]
}

export type ScimResult = { status: number; headers: Headers; body: ScimBody }

export const uniqueSuffix = () => crypto.randomUUID().slice(0, 8)

/** An Entra-shaped `POST /Users` body. */
export const entraUser = (userName: string, externalId: string): ScimBody => ({
  schemas: [scimUserSchema, scimEnterpriseSchema],
  externalId,
  userName,
  active: true,
  emails: [{ primary: true, type: 'work', value: userName }],
  name: { formatted: 'Ada Lovelace', familyName: 'Lovelace', givenName: 'Ada' },
  displayName: 'Ada Lovelace',
  [scimEnterpriseSchema]: { department: 'Finance' },
})

/** A Keycloak-extension-shaped `POST /Users` body. */
export const keycloakUser = (userName: string, email: string, externalId: string): ScimBody => ({
  schemas: [scimUserSchema],
  externalId,
  userName,
  name: { givenName: 'Alice', familyName: 'Liddell' },
  emails: [{ value: email, type: 'work', primary: true }],
  active: true,
})

/** A client for one bearer token over any SCIM request handler. */
export const createScimClient = (handle: (request: Request) => Promise<Response>, token?: string) => {
  const call = async (
    method: string,
    path: string,
    options: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<ScimResult> => {
    const bearer = options.token === undefined ? token : options.token
    const headers: Record<string, string> = { ...options.headers }
    if (bearer) {
      headers.authorization = `Bearer ${bearer}`
    }
    if (options.body !== undefined) {
      headers['content-type'] = 'application/scim+json'
    }
    const response = await handle(
      new Request(`${scimBaseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
    )
    const text = await response.text()
    return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as ScimBody) : {} }
  }
  const patch = (path: string, operations: unknown[], options: { token?: string | null } = {}) =>
    call('PATCH', path, { ...options, body: { schemas: [scimPatchSchema], Operations: operations } })
  return { call, patch }
}

export type ScimClient = ReturnType<typeof createScimClient>

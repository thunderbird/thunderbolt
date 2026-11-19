/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq, like, or } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { providerConnectionSecretsTable as secrets } from '@/db/tables'
import {
  assertProviderConnectionAttemptCurrent,
  type ProviderConnectionAttempt,
} from '@/lib/provider-connection-attempt'
import { writeProviderCredentials } from './credentials'
import type { ChatGPTRegistration, ProviderCredentials } from './types'

const prefix = 'chatgpt-registration:'

/** Registrations have no renewable tokens and never participate in synced connection metadata. */
const readRegistrations = async (db: AnyDrizzleDatabase) => {
  const rows = await db
    .select()
    .from(secrets)
    .where(or(eq(secrets.id, 'oauth:openai'), like(secrets.id, `${prefix}%`)))
    .orderBy(secrets.id)
  const active = rows.find((row) => row.id === 'oauth:openai')
  const credentials = JSON.parse(active?.credentials ?? '{}') as ProviderCredentials
  const registrations = rows.flatMap((row) => {
    const stored = JSON.parse(row.credentials ?? '{}') as ProviderCredentials
    return stored.chatGPTRegistration ? [stored.chatGPTRegistration] : []
  })
  // The active record also supports credentials saved before account selection was introduced.
  if (credentials.oauth && !registrations.some((entry) => entry.clientId === credentials.oauth?.clientId)) {
    registrations.push(credentials.oauth)
  }
  return { registrations, credentials }
}

/** Exposes only account labels and selection IDs, never OAuth tokens, to the account picker. */
export const listChatGPTAccounts = async (db: AnyDrizzleDatabase) => {
  const { registrations, credentials } = await readRegistrations(db)
  return registrations.map((registration) => ({
    clientId: registration.clientId,
    label: `${registration.name || registration.email || 'ChatGPT'} · ${registration.clientId}`,
    active: Boolean(credentials.access_token && credentials.oauth?.clientId === registration.clientId),
  }))
}

/** Undefined resumes the active or saved registration; null explicitly registers a different account. */
export const readChatGPTRegistration = async (
  db: AnyDrizzleDatabase,
  selectedClientId?: string | null,
): Promise<(ChatGPTRegistration & { idToken?: string; scope?: string }) | undefined> => {
  if (selectedClientId === null) {
    return undefined
  }
  const { registrations, credentials } = await readRegistrations(db)
  const clientId = selectedClientId ?? credentials.oauth?.clientId ?? registrations[0]?.clientId
  const registration = registrations.find((entry) => entry.clientId === clientId)
  if (selectedClientId && !registration) {
    throw new Error('ChatGPT account registration was not found')
  }
  return credentials.oauth?.clientId === clientId ? credentials.oauth : registration
}

/** Write account identity without tokens; callers own the transaction and lifecycle guards. */
export const writeChatGPTRegistration = async (db: AnyDrizzleDatabase, registration: ChatGPTRegistration) => {
  const { registrations } = await readRegistrations(db)
  const existing = registrations.find((entry) => entry.clientId === registration.clientId)
  if (existing?.subject && registration.subject && existing.subject !== registration.subject) {
    throw new Error('ChatGPT account did not match this registration')
  }
  await writeProviderCredentials(
    db,
    `${prefix}${registration.clientId}`,
    {
      chatGPTRegistration: {
        clientId: registration.clientId,
        subject: registration.subject ?? existing?.subject,
        email: registration.email ?? existing?.email,
        name: registration.name ?? existing?.name,
      },
    },
    null,
  )
}

/** Keep issued clients across exchange failures, binding identity only after signature verification. */
export const retainChatGPTRegistration = async (
  db: AnyDrizzleDatabase,
  registration: ChatGPTRegistration,
  attempt: ProviderConnectionAttempt<'openai'>,
  signal: AbortSignal,
) => {
  await db.transaction(async (tx) => {
    signal.throwIfAborted()
    await assertProviderConnectionAttemptCurrent(tx, attempt)
    await writeChatGPTRegistration(tx, registration)
    signal.throwIfAborted()
  })
}

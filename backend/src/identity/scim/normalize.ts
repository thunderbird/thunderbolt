/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Rewrites provider SCIM requests into shapes the plugin accepts, and refuses what it must not
 * accept. Every function is pure: the caller supplies the stored resource where one is needed.
 */

export type ScimJson = Record<string, unknown>

export type ScimPatchOperation = { op?: unknown; path?: unknown; value?: unknown }

/** A refusal, answered as a SCIM error. */
export type ScimRefusal = { status: 400; detail: string; scimType: 'invalidValue' | 'mutability' | 'noTarget' }

type Email = { value: string } & ScimJson

const extensionSchemaPrefix = 'urn:ietf:params:scim:schemas:extension:'
const enterpriseUserSchema = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'
const coreUserSchemaPrefix = 'urn:ietf:params:scim:schemas:core:2.0:user:'

/** An extension schema the plugin doesn't support, such as an Entra directory extension. */
const isUnsupportedExtension = (name: string) =>
  name.toLowerCase().startsWith(extensionSchemaPrefix) &&
  !name.toLowerCase().startsWith(enterpriseUserSchema.toLowerCase())

/** Whether a value is a plain object, not an array or null. */
const isRecord = (value: unknown): value is ScimJson =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The operation's path, or undefined when it has none. A blank path is pathless to the plugin too. */
const patchPath = (operation: ScimPatchOperation) =>
  typeof operation.path === 'string' && operation.path.trim() !== '' ? operation.path.trim() : undefined

/** The value's attributes without the unsupported extension blocks. */
const withoutUnsupportedExtensions = (value: ScimJson) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !isUnsupportedExtension(key)))

/**
 * Drop unsupported extension schemas from a POST or PUT body: their `schemas` entries and their
 * attribute blocks. The plugin answers 400 to any schema it doesn't know.
 */
export const stripUnsupportedExtensions = (resource: ScimJson): ScimJson => {
  const stripped = withoutUnsupportedExtensions(resource)
  return Array.isArray(resource.schemas)
    ? {
        ...stripped,
        schemas: resource.schemas.filter((name) => typeof name !== 'string' || !isUnsupportedExtension(name)),
      }
    : stripped
}

/**
 * Drop PATCH operations on unsupported extension attributes, and such attributes from pathless
 * values. An operation left with nothing to change is dropped too.
 */
export const stripUnsupportedExtensionOperations = (operations: ScimPatchOperation[]): ScimPatchOperation[] =>
  operations.flatMap((operation) => {
    const path = patchPath(operation)
    if (path) {
      return isUnsupportedExtension(path) ? [] : [operation]
    }
    if (!isRecord(operation.value)) {
      return [operation]
    }
    const value = withoutUnsupportedExtensions(operation.value)
    return Object.keys(value).length === 0 ? [] : [{ ...operation, value }]
  })

const emailValuePath = /^emails\s*\[\s*value\s+eq\s+"([^"]*)"\s*\](\s*\.\s*value)?$/i

/** The operation's name in lower case; a missing `op` is a replace, as the plugin reads it. */
const opName = (operation: ScimPatchOperation) =>
  typeof operation.op === 'string' ? operation.op.toLowerCase() : 'replace'

/** Entra and others wrap a single value in an array. */
const unwrapSingle = (value: unknown) => (Array.isArray(value) && value.length === 1 ? value[0] : value)

/** The address in an email value: a bare string or an object's `value`, unwrapped from a one-item array. Undefined when it holds none. */
const readEmailValue = (value: unknown) => {
  const unwrapped = unwrapSingle(value)
  if (typeof unwrapped === 'string') {
    return unwrapped
  }
  return isRecord(unwrapped) && typeof unwrapped.value === 'string' ? unwrapped.value : undefined
}

/** The email an `emails[value eq "…"]` replace leaves: a new address, or (without `.value`) new sub-attributes. */
const replaceEmail = (current: Email, value: unknown, addressOnly: boolean): Email | undefined => {
  const unwrapped = unwrapSingle(value)
  if (!addressOnly && isRecord(unwrapped)) {
    const merged = { ...current, ...unwrapped }
    return typeof merged.value === 'string' ? (merged as Email) : undefined
  }
  const address = readEmailValue(unwrapped)
  return address === undefined ? undefined : { ...current, value: address }
}

/** Whether two addresses are the same, ignoring case and surrounding spaces. */
const sameAddress = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase()

const emailTypeValuePath = /^emails\s*\[\s*type\s+eq\s+"([^"]+)"\s*\]\s*\.\s*value$/i
const emailPrimaryValuePath = /^emails\s*\[\s*primary\s+eq\s+"?true"?\s*\]\s*\.\s*value$/i

/** The value as a list of emails, or undefined when it isn't an array of objects that each carry a string `value`. */
const readEmailList = (value: unknown): Email[] | undefined =>
  Array.isArray(value) && value.every((email) => isRecord(email) && typeof email.value === 'string')
    ? (value as Email[])
    : undefined

/** The list `emails` add leaves: new addresses appended, and a new primary taking over. */
const addEmails = (emails: Email[], additions: Email[]) => {
  const added = additions.filter(
    (addition) => !emails.some((email) => sameAddress(email.value, addition.value) && email.type === addition.type),
  )
  const kept = added.some((email) => email.primary) ? emails.map((email) => ({ ...email, primary: false })) : emails
  return added.length === 0 ? emails : [...kept, ...added]
}

/** An operation on the whole `emails` list, given as a path or as a pathless value's attribute. */
const applyEmailList = (emails: Email[], op: string, value: unknown) => {
  const list = readEmailList(value)
  if (!list || op === 'remove') {
    return emails
  }
  return op === 'add' ? addEmails(emails, list) : list
}

/** Replace the value of each email `matches` picks. */
const replaceAddress = (emails: Email[], value: unknown, matches: (email: Email) => boolean) => {
  const address = readEmailValue(value)
  return address === undefined ? emails : emails.map((email) => (matches(email) ? { ...email, value: address } : email))
}

/** A `type` filter: replace that type's address, add it when absent, or remove that type's entries. */
const applyTypeFilter = (emails: Email[], op: string, type: string, value: unknown) => {
  const matches = (email: Email) => typeof email.type === 'string' && email.type.toLowerCase() === type.toLowerCase()
  if (op === 'remove') {
    return emails.filter((email) => !matches(email))
  }
  if (emails.some(matches)) {
    return replaceAddress(emails, value, matches)
  }
  const address = readEmailValue(value)
  return address === undefined ? emails : [...emails, { value: address, type: type.toLowerCase(), primary: false }]
}

/**
 * The list an email operation the plugin handles itself leaves, mirroring how the plugin applies
 * it, so a value filter later in the same PATCH sees the addresses as they are by then. An
 * operation the plugin will refuse leaves the list as it was: the PATCH fails either way.
 */
const applyEmailOperation = (emails: Email[], operation: ScimPatchOperation): Email[] => {
  const op = opName(operation)
  const path = patchPath(operation)
  if (!path) {
    const entry =
      isRecord(operation.value) && Object.entries(operation.value).find(([key]) => key.toLowerCase() === 'emails')
    return entry ? applyEmailList(emails, op, entry[1]) : emails
  }
  const attribute = path.toLowerCase().startsWith(coreUserSchemaPrefix) ? path.slice(coreUserSchemaPrefix.length) : path
  if (attribute.toLowerCase() === 'emails') {
    return applyEmailList(emails, op, operation.value)
  }
  if (/^emails\s*\.\s*value$/i.test(attribute)) {
    return op === 'remove' ? emails : replaceAddress(emails, operation.value, () => true)
  }
  const typeMatch = emailTypeValuePath.exec(attribute)
  if (typeMatch) {
    return applyTypeFilter(emails, op, typeMatch[1].trim(), operation.value)
  }
  if (emailPrimaryValuePath.test(attribute)) {
    return op === 'remove' ? emails : replaceAddress(emails, operation.value, (email) => email.primary === true)
  }
  return emails
}

/**
 * Rewrite `emails[value eq "x"].value` and `emails[value eq "x"]` (RFC 7644 value filters, the
 * form the Keycloak extension sends) into a replace of the whole `emails` list. The plugin
 * supports only `type` and `primary` filters there. `currentEmails` is the stored list; each
 * rewritten operation works on the list every operation before it left, the plugin's own included.
 */
export const rewriteEmailValueFilters = (
  operations: ScimPatchOperation[],
  currentEmails: Email[],
): { operations: ScimPatchOperation[] } | { refusal: ScimRefusal } => {
  let emails = currentEmails
  const rewritten: ScimPatchOperation[] = []
  for (const operation of operations) {
    const path = patchPath(operation)
    const match = path ? emailValuePath.exec(path) : null
    if (!match) {
      emails = applyEmailOperation(emails, operation)
      rewritten.push(operation)
      continue
    }
    const [, target, valueSuffix] = match
    const index = emails.findIndex((email) => sameAddress(email.value, target))
    if (index === -1) {
      return { refusal: { status: 400, scimType: 'noTarget', detail: `No email matches ${operation.path}` } }
    }
    if (opName(operation) === 'remove') {
      emails = emails.filter((_, position) => position !== index)
    } else {
      const replacement = replaceEmail(emails[index], operation.value, valueSuffix !== undefined)
      if (!replacement) {
        return { refusal: { status: 400, scimType: 'invalidValue', detail: `${operation.path} needs an email value` } }
      }
      emails = emails.map((email, position) => (position === index ? replacement : email))
    }
    rewritten.push({ op: 'replace', path: 'emails', value: emails })
  }
  return { operations: rewritten }
}

const coreUserSchema = coreUserSchemaPrefix.slice(0, -1)

/** Whether a PATCH path names `externalId`, bare or prefixed with the core User schema, in any case. */
const isExternalIdPath = (path: string) => {
  const normalized = path.trim().toLowerCase()
  return (
    normalized === 'externalid' ||
    (normalized.startsWith(coreUserSchemaPrefix) && normalized.slice(coreUserSchemaPrefix.length) === 'externalid')
  )
}

/** Whether a path is the core User schema URN itself, whose value is an object of core attributes. */
const isCoreUserSchema = (path: string) => path.trim().toLowerCase() === coreUserSchema

/**
 * Every `externalId` a User value carries, under any spelling the plugin accepts: `externalId` in
 * any case, prefixed with the core schema, or inside a core-schema object. A value that hides a
 * second spelling behind the first must not pass on the first one alone.
 */
const externalIdValues = (value: ScimJson): unknown[] =>
  Object.entries(value).flatMap(([key, entry]) => {
    if (isExternalIdPath(key)) {
      return [entry]
    }
    return isCoreUserSchema(key) && isRecord(entry) ? externalIdValues(entry) : []
  })

const externalIdLocked: ScimRefusal = {
  status: 400,
  scimType: 'mutability',
  detail: 'externalId cannot change once set',
}

/**
 * Refuse a PATCH that would change or remove an `externalId` that is already set: it is the IdP's
 * stable id, and changing it hands the account to whoever the new id names. Setting the same
 * value again is allowed; the Keycloak extension does that on every update.
 */
export const guardExternalIdPatch = (
  operations: ScimPatchOperation[],
  storedExternalId: string | undefined,
): ScimRefusal | undefined => {
  if (!storedExternalId) {
    return undefined
  }
  const changes = operations.some((operation) => {
    const path = patchPath(operation)
    if (path && isExternalIdPath(path)) {
      return opName(operation) === 'remove' || unwrapSingle(operation.value) !== storedExternalId
    }
    if (path && !isCoreUserSchema(path)) {
      return false
    }
    const value = unwrapSingle(operation.value)
    return isRecord(value) && externalIdValues(value).some((candidate) => candidate !== storedExternalId)
  })
  return changes ? externalIdLocked : undefined
}

/**
 * A PUT replaces the resource. A different `externalId` is refused; a missing one is read as no
 * change and keeps the stored value, since some providers leave it out of a replace.
 */
export const guardExternalIdPut = (
  resource: ScimJson,
  storedExternalId: string | undefined,
): { resource: ScimJson } | { refusal: ScimRefusal } => {
  if (!storedExternalId) {
    return { resource }
  }
  const values = externalIdValues(resource)
  if (values.every((value) => value === undefined || value === null)) {
    const withoutExternalId = Object.fromEntries(Object.entries(resource).filter(([key]) => !isExternalIdPath(key)))
    return { resource: { ...withoutExternalId, externalId: storedExternalId } }
  }
  return values.every((value) => value === storedExternalId) ? { resource } : { refusal: externalIdLocked }
}

/**
 * A user without `externalId` can never be linked to an SSO identity, nor reprovisioned after a
 * DELETE, so creating one is refused.
 */
export const requireExternalId = (resource: ScimJson): ScimRefusal | undefined =>
  typeof resource.externalId === 'string' && resource.externalId.trim() !== ''
    ? undefined
    : {
        status: 400,
        scimType: 'invalidValue',
        detail: 'externalId is required: map the IdP user id to externalId in the provisioning settings',
      }

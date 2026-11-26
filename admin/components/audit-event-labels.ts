/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { I18n, MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { parseUserAgent, type WebBrowser, type WebOsPlatform } from '@/lib/platform'
import type { AuditActorType, AuditEvent, AuditOutcome } from '@shared/admin-api'
import { getAuditActionLabel, getAuditTargetLabel } from '../api/audit-action-labels'
import type { StatusTone } from './status-badge'

export const actorTypeLabels: Record<AuditActorType, MessageDescriptor> = {
  user: msg`Person`,
  api_key: msg`API key`,
  scim_connection: msg`SCIM connection`,
  system: msg`System`,
}

export const outcomeLabels: Record<AuditOutcome, MessageDescriptor> = {
  success: msg`Success`,
  failure: msg`Failure`,
  denied: msg`Denied`,
}

export const outcomeTones: Record<AuditOutcome, StatusTone> = {
  success: 'success',
  failure: 'danger',
  denied: 'warning',
}

const osLabels: Record<Exclude<WebOsPlatform, 'unknown'>, MessageDescriptor> = {
  macos: msg`macOS`,
  windows: msg`Windows`,
  linux: msg`Linux`,
  ios: msg`iOS`,
  android: msg`Android`,
}

const browserLabels: Record<Exclude<WebBrowser, 'unknown'>, MessageDescriptor> = {
  chrome: msg`Chrome`,
  edge: msg`Edge`,
  firefox: msg`Firefox`,
  safari: msg`Safari`,
}

/**
 * "Firefox on macOS", or whichever half the user agent names. Null for a client neither half recognises
 * (curl, the CLI, an SDK), which shows its raw string instead.
 */
export const readableClient = (i18n: I18n, userAgent: string): string | null => {
  const { os, browser } = parseUserAgent(userAgent)
  const osName = os === 'unknown' ? null : i18n._(osLabels[os])
  const browserName = browser === 'unknown' ? null : i18n._(browserLabels[browser])
  if (osName && browserName) {
    return i18n._(msg`${browserName} on ${osName}`)
  }
  return browserName ?? osName
}

/** The action's label, or its raw id when this build doesn't know it. */
export const auditActionName = (i18n: I18n, action: string) => {
  const label = getAuditActionLabel(action)
  return label ? i18n._(label) : action
}

/** The actor's name when the server knows one, else what kind of actor it is. */
export const auditActorName = (i18n: I18n, event: AuditEvent) =>
  event.actorLabel ?? i18n._(actorTypeLabels[event.actorType])

/** The target type's label, or the raw type when this build doesn't know it. */
export const auditTargetTypeName = (i18n: I18n, targetType: string) => {
  const label = getAuditTargetLabel(targetType)
  return label ? i18n._(label) : targetType
}

/** A sign-in's target is its own actor; naming the person twice says nothing. */
export const targetIsActor = (event: AuditEvent) =>
  event.targetType === event.actorType && event.targetId === event.actorId

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { assumptionKeys, defaultPlan, parseMonth, type Plan } from './model'

/** Bump the suffix when the shape of `Plan` changes incompatibly. */
export const planStorageKey = 'runway-planner:plan:v1'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isMonth = (value: unknown): value is string => typeof value === 'string' && parseMonth(value) !== null

const isHire = (value: unknown) =>
  isRecord(value) && typeof value.role === 'string' && isNumber(value.monthlyCost) && isMonth(value.startMonth)

const isRound = (value: unknown) =>
  isRecord(value) && typeof value.label === 'string' && isNumber(value.amount) && isMonth(value.month)

const isPlan = (value: unknown): value is Plan =>
  isRecord(value) &&
  assumptionKeys.every((key) => isNumber(value[key])) &&
  Array.isArray(value.hires) &&
  value.hires.every(isHire) &&
  Array.isArray(value.rounds) &&
  value.rounds.every(isRound)

/** Read a stored plan. Anything missing or malformed falls back to the default plan. */
export const parsePlan = (raw: string | null): Plan => {
  if (raw === null) {
    return defaultPlan
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return isPlan(parsed) ? parsed : defaultPlan
  } catch {
    return defaultPlan
  }
}

/** The string to store for a plan, or null for the default plan (which clears the entry). */
export const serializePlan = (plan: Plan): string | null => {
  const json = JSON.stringify(plan)
  return json === JSON.stringify(defaultPlan) ? null : json
}

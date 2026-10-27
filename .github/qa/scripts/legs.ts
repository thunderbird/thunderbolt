#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { type Platform, parseSession, platformIds, platformOf, realAiCharters } from './findings'

/** `charter` is the session id. */
export type Leg = {
  charter: string
  dist: string
  out: string
  artifact: string
  mcp: string
  viewport: string
  platform: string
  driver: Platform['driver']
  runner: string
  onboarding: boolean
  real: boolean
  postgres: boolean
}

export type VerifyLeg = {
  name: string
  /** The platform id of a native leg, `web` for the web legs, which replay desktop and phone together. */
  platform: string
  runner: string
  out: string
  artifact: string
  dist: string
  onboarding: boolean
  postgres: boolean
  real?: boolean
}

const baseLeg = {
  dist: 'qa-dist',
  out: 'qa-out',
  onboarding: false,
  real: false,
  postgres: false,
}

/** The free session of the week is added by `allLegs`. */
const charters: (Partial<Leg> & { charter: string })[] = [
  { charter: 'c1-first-run', onboarding: true },
  { charter: 'c2-chat-power-user' },
  { charter: 'c3-models-providers' },
  { charter: 'c4-skills-projects' },
  { charter: 'c5-widgets-connections' },
  { charter: 'c6-settings-data' },
  { charter: 'c7-two-devices', postgres: true },
]

export const onboardingSession = (session: string) =>
  charters.some((c) => c.onboarding && session.startsWith(`${c.charter}-`))

export const syncSession = (session: string) => charters.some((c) => c.postgres && session.startsWith(`${c.charter}-`))

/**
 * Sessions the grid leaves out, with the reason. `planLegs` drops them before it reads `only`, so asking for one fails
 * as an unknown id, and it reports the ones a dispatch would have run.
 */
const skippedSessions = [
  {
    session: 'c7-two-devices-ios',
    reason:
      'The macOS runner has no Docker, so it cannot run the Postgres and PowerSync containers the second device needs.',
  },
]

const artifactName = (platform: Platform, kind: 'explore' | 'sync' | 'real') => {
  if (platform.driver === 'playwright') return `qa-${kind}`
  return kind === 'explore' ? `qa-${platform.id}` : `qa-${platform.id}-${kind}`
}

/** A charter id in `only` picks it on every platform, `free` the free sessions. `report.ts` shares this rule. */
export const selects = (only: string[], session: string) =>
  only.length === 0 ||
  only.includes(session) ||
  only.includes(parseSession(session).charter) ||
  (session.startsWith('free-') && only.includes('free'))

/** One extra leg per canary, on the canary build; canaries are web charters only. */
const allLegs = (journey: string, canaries: { charter: string }[]): Leg[] => {
  const sessions = [...charters, { charter: `free-${journey}` }].flatMap((c) =>
    platformIds.map(platformOf).map((platform): Leg => {
      const session = `${c.charter}-${platform.id}`
      // c7's second browser is added to whichever platform's config the session would use.
      const mcp = c.charter === 'c7-two-devices' ? `${platform.mcp} .github/qa/mcp-two-devices.json` : platform.mcp
      const real = realAiCharters.has(session)
      const kind = real ? 'real' : c.postgres ? 'sync' : 'explore'
      return {
        ...baseLeg,
        ...c,
        charter: session,
        mcp,
        viewport: platform.viewport,
        platform: platform.id,
        driver: platform.driver,
        runner: platform.runner,
        artifact: artifactName(platform, kind),
        real,
      }
    }),
  )
  const canaryLegs = canaries.flatMap((canary) =>
    sessions
      .filter((leg) => leg.charter === canary.charter)
      .map((leg) => ({ ...leg, dist: 'qa-dist-canary', out: 'qa-out-canary', artifact: 'qa-canary' })),
  )
  return [...sessions, ...canaryLegs]
}

/** The web replay leg, which also judges every leg's candidates. */
const weeklyLeg = (legs: Leg[]): VerifyLeg => ({
  name: 'weekly',
  platform: 'web',
  runner: platformOf('desktop').runner,
  out: 'qa-out',
  artifact: 'qa-explore',
  dist: 'qa-dist',
  onboarding: legs.some((leg) => leg.onboarding),
  postgres: false,
})

const verifyLegs = (legs: Leg[]): VerifyLeg[] => {
  const has = (artifact: string) => legs.some((leg) => leg.artifact === artifact)
  const weekly = weeklyLeg(legs)
  const sync: VerifyLeg = { ...weekly, name: 'sync', artifact: 'qa-sync', onboarding: false, postgres: true }
  const real: VerifyLeg = { ...weekly, name: 'real', artifact: 'qa-real', onboarding: false, real: true }
  // The canary findings replay on the canary build, then on the normal one: a canary counts only when its finding
  // fails on the first and passes on the second. canaries.ts picks charters of one kind of AI.
  const canaryReal = legs.some((leg) => leg.artifact === 'qa-canary' && leg.real)
  const canary = [
    { name: 'canary', out: 'qa-out-canary', dist: 'qa-dist-canary' },
    { name: 'canary-baseline', out: 'qa-out-canary-baseline', dist: 'qa-dist' },
  ].map(
    (leg): VerifyLeg => ({
      ...weekly,
      ...leg,
      artifact: 'qa-canary',
      onboarding: false,
      postgres: false,
      real: canaryReal,
    }),
  )
  return [
    weekly,
    ...(has('qa-sync') ? [sync] : []),
    ...(has('qa-real') ? [real] : []),
    ...(has('qa-canary') ? canary : []),
  ]
}

const nativeVerifyLegs = (legs: Leg[]): VerifyLeg[] =>
  legs
    .filter((leg, i) => legs.findIndex((other) => other.artifact === leg.artifact) === i)
    .map((leg) => ({
      name: leg.artifact.replace(/^qa-/, ''),
      platform: leg.platform,
      runner: leg.runner,
      out: 'qa-out',
      artifact: leg.artifact,
      dist: 'qa-dist',
      onboarding: legs.some((other) => other.platform === leg.platform && other.onboarding),
      postgres: leg.postgres,
      real: leg.real,
    }))

/**
 * The `weekly` judge leg judges the native candidates too, so a dispatch of native sessions only still plans it, with
 * no web replay behind it. Throws on an id in `only` that names no session, charter or `free`; a session in
 * `skippedSessions` names none.
 */
export const planLegs = (input: { only: string[]; journey: string; canaries: { charter: string }[] }) => {
  const skippedIds = new Set(skippedSessions.map((s) => s.session))
  const all = allLegs(input.journey, input.canaries).filter((leg) => !skippedIds.has(leg.charter))
  const known = new Set(['free', ...all.flatMap((leg) => [leg.charter, parseSession(leg.charter).charter])])
  const unknown = input.only.filter((id) => !known.has(id))
  if (unknown.length > 0) throw new Error(`Unknown charter ${unknown.join(' ')}`)
  const selected = all.filter((leg) => selects(input.only, leg.charter))
  const legs = selected.filter((leg) => leg.driver === 'playwright')
  const nativeLegs = selected.filter((leg) => leg.driver === 'maestro')
  const verify = legs.length > 0 ? verifyLegs(legs) : []
  const nativeVerify = nativeVerifyLegs(nativeLegs)
  const judged = verify.length > 0 || nativeVerify.length === 0 ? verify : [weeklyLeg([])]
  return {
    legs,
    nativeLegs,
    verify,
    nativeVerify,
    judge: judged.filter((v) => v.name === 'weekly' || v.name === 'canary'),
    skipped: skippedSessions.filter((s) => selects(input.only, s.session)),
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { charters: { type: 'string', default: '' }, journey: { type: 'string' }, canaries: { type: 'string' } },
  })
  if (!values.journey || !values.canaries)
    throw new Error('usage: legs.ts --charters "<ids>" --journey <id> --canaries <file>')
  try {
    const only = values.charters.split(/[ ,]+/).filter(Boolean)
    if (values.charters && only.length === 0) throw new Error(`No charter id in '${values.charters}'`)
    const plan = planLegs({
      only,
      journey: values.journey,
      canaries: JSON.parse(await readFile(values.canaries, 'utf8')),
    })
    for (const [name, value] of Object.entries(plan)) console.log(`${name}=${JSON.stringify(value)}`)
  } catch (error) {
    // A workflow annotation, so the run's summary shows the reason.
    console.log(`::error::${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}

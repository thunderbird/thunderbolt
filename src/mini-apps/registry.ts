/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Registry of Mini Apps — remotely-hosted surfaces embedded as first-class pages.
 *
 * Onboarding a customer app should be adding an entry here and nothing else. If
 * a new app ever needs a code change beyond this array, the bridge protocol
 * (`shared/mini-app-protocol.ts`) is the thing to fix, not this file.
 *
 * Static for the PoC. Provisioning these per account/deployment is deliberately
 * out of scope — see the plan's non-goals.
 */

import type { LucideIcon } from 'lucide-react'
import { LineChart, Route } from 'lucide-react'

export type MiniAppDefinition = {
  /** URL segment and stable key: `/apps/<id>`. */
  id: string
  /** Sidebar label and chrome title. */
  name: string
  /** One line, shown as a tooltip; also given to the model in the prompt section. */
  description: string
  icon: LucideIcon
  /** Full URL loaded into the frame. */
  url: string
  /**
   * Exact origin the frame is expected to post from, compared against
   * `event.origin`. Kept separate from `url` rather than derived: a redirect
   * could move `url` to a different origin, and the value we check against must
   * be the one an operator declared, not one the app can influence.
   */
  origin: string
}

/**
 * The PoC sample app (`~/code/sample_finance_app`). Runs on 5174 so it doesn't
 * collide with Vite on 5173.
 */
const financeModelApp: MiniAppDefinition = {
  id: 'finance-model',
  name: 'Finance Model',
  description: 'Quarterly revenue and headcount model with editable assumptions.',
  icon: LineChart,
  url: 'http://localhost:5174',
  origin: 'http://localhost:5174',
}

/**
 * Patient Journeys (`~/code/patient_journeys_app`). Runs on 5180 rather than the
 * next port up from the finance app: `next dev` silently walks forward when its
 * port is taken, so two sample apps on adjacent numbers can quietly swap places.
 */
const patientJourneysApp: MiniAppDefinition = {
  id: 'patient-journeys',
  name: 'Patient Journeys',
  description: 'Disease-by-disease maps of how patients reach diagnosis and treatment, for launch planning.',
  icon: Route,
  url: 'http://localhost:5180',
  origin: 'http://localhost:5180',
}

export const miniAppRegistry: MiniAppDefinition[] = [financeModelApp, patientJourneysApp]

/** Look up a registered app by its route id. */
export const findMiniApp = (id: string | undefined): MiniAppDefinition | undefined =>
  miniAppRegistry.find((app) => app.id === id)

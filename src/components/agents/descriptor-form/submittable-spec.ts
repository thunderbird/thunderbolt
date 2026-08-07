/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { visibleFields, type AgentDescriptor, type AgentSpec } from '@shared/agent-descriptors'

/**
 * Reduce the raw react-hook-form values to the spec we actually submit: only the
 * currently-visible fields, with defined values. Fields toggled off via
 * `visibleWhen` keep their value in RHF state, so without this filter a hidden
 * value would be posted and rejected by the backend's re-validation.
 */
export const submittableSpec = (descriptor: AgentDescriptor, values: AgentSpec): AgentSpec => {
  const visible = new Set(visibleFields(descriptor, values).map((field) => field.key))
  const spec: AgentSpec = {}
  for (const [key, value] of Object.entries(values)) {
    if (visible.has(key) && value !== undefined) {
      spec[key] = value
    }
  }
  return spec
}

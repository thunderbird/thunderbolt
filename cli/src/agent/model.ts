/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Resolves an Anthropic model id against Pi's built-in catalog.
 *
 * Pi's `@earendil-works/pi-ai/providers/all` is the only entry point that wires
 * the providers; bare `createModels()` returns an empty collection. The wired
 * collection's anthropic provider resolves `ANTHROPIC_API_KEY` from the
 * environment automatically. The specific model is looked up by id via
 * `Models.getModel`, the non-deprecated runtime accessor that accepts an
 * arbitrary string id (unlike the catalog-key-typed `getBuiltinModel`).
 */

import type { Api, Model, Models } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'

/** Provider whose models the CLI talks to. */
const PROVIDER = 'anthropic'

/**
 * Builds the wired provider collection and resolves a single Anthropic model.
 *
 * @param requestedId - the Anthropic model id to run (e.g. `claude-opus-4-8`)
 * @returns the provider collection and the resolved model, ready for the harness
 * @throws if `requestedId` is not in Pi's built-in Anthropic catalog
 */
export const resolveModel = (requestedId: string): { models: Models; model: Model<Api> } => {
  const models = builtinModels()
  const model = models.getModel(PROVIDER, requestedId)
  if (!model) {
    throw new Error(`Unknown Anthropic model "${requestedId}".`)
  }
  return { models, model }
}

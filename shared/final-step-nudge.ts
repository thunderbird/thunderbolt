/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * What an agent's final step adds to the prompt once its tools are withheld, so a run still calling tools at the
 * step cap answers instead of ending on a call. Shared so the built-in pipeline (`buildStepOverrides`,
 * `src/ai/step-logic.ts`) and the hosted agent (`backend/src/hosted-agent/routes.ts`) cannot drift apart.
 */
export const finalStepNudge = 'RESPOND NOW with the information gathered. Do not ask questions.'

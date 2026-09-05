/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The shape of `GET /mini-apps`, declared once for both ends.
 *
 * Separate from `mini-app-protocol.ts` because it is a different boundary: that
 * file is the `postMessage` contract with a customer's app, this is the HTTP
 * contract between our own backend and our own client. They change for
 * different reasons and neither should drag the other along.
 *
 * It lives in `shared/` because it was previously written twice — a
 * `PublicMiniApp` type on the backend and a `miniAppResponseSchema` on the
 * frontend, structurally coupled and free to drift. They already had: the
 * backend refused a non-http(s) `origin` while the client accepted any string,
 * so the one value that reaches `<iframe src>` was scheme-checked on one side
 * of the boundary only.
 *
 * The registry's own docs make the same argument about presentation data, which
 * used to be a hardcoded frontend array: two lists of the same apps that can
 * disagree, where the failure is silent.
 */

import { z } from 'zod'

/**
 * An absolute http(s) URL.
 *
 * `url` reaches `<iframe src>` and `origin` is what every inbound guest message
 * is compared against, so a `javascript:` value would execute in our page
 * rather than in a frame. Checked on both ends deliberately: the backend
 * refuses to publish one, and the client refuses to render one, because the
 * backend a client talks to is a local setting.
 */
export const httpUrlField = z.string().refine(
  (value) => {
    try {
      const { protocol } = new URL(value)
      return protocol === 'http:' || protocol === 'https:'
    } catch {
      return false
    }
  },
  { message: 'must be an http(s) URL' },
)

/**
 * One app as the client receives it — every field of the operator's config
 * except the signing secret.
 *
 * `description` and `icon` default rather than being required: they are
 * presentation, and an operator who omits them should get an app that works
 * rather than an app that is dropped.
 */
export const publicMiniAppSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  icon: z.string().default(''),
  url: httpUrlField,
  origin: httpUrlField,
})

/** The registry envelope. */
export const miniAppRegistrySchema = z.object({ apps: z.array(z.unknown()) })

export type PublicMiniApp = z.infer<typeof publicMiniAppSchema>

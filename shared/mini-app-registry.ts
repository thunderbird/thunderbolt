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
 * frontend, structurally coupled and free to drift. They did drift, once: the
 * backend refused a non-http(s) `origin` while the client accepted any string,
 * so the one value that reaches `<iframe src>` was scheme-checked on one side
 * of the boundary only. That gap was closed by teaching the client the same
 * rule; declaring the rule once is what stops the next one.
 *
 * The registry's own docs make the same argument about presentation data, which
 * used to be a hardcoded frontend array: two lists of the same apps that can
 * disagree, where the failure is silent.
 *
 * **This module must stay free of third-party imports.** The backend reaches it
 * through `@shared/*`, and `deploy/docker/backend.Dockerfile` installs only
 * `backend/node_modules` before copying `shared/` in beside it — so a bare
 * `import { z } from 'zod'` here resolves from `/app/shared`, finds nothing, and
 * takes the server down at boot. Locally it appears to work, because the repo
 * root has its own `node_modules` (with its own, separately-pinned zod). Hence
 * the split below: `shared/` declares the *contract* — the type and the one rule
 * both ends must agree on — and each end builds its own zod schema from it, as
 * the backend already did for the operator-facing config in
 * `backend/src/config/settings.ts`.
 */

/**
 * True for an absolute http(s) URL.
 *
 * `url` reaches `<iframe src>` and `origin` is what every inbound guest message
 * is compared against, so a `javascript:` value would execute in our page
 * rather than in a frame. Checked on both ends deliberately: the backend
 * refuses to publish one, and the client refuses to render one, because the
 * backend a client talks to is a local setting.
 *
 * @param value - Candidate URL string, from operator config or the wire.
 */
export const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** The message both ends attach to a failed {@link isHttpUrl} check. */
export const httpUrlMessage = 'must be an http(s) URL'

/**
 * One app as the client receives it — every field of the operator's config
 * except the signing secret.
 *
 * `description` and `icon` are always present on the wire because both ends
 * default them: they are presentation, and an operator who omits them should
 * get an app that works rather than an app that is dropped.
 */
export type PublicMiniApp = {
  /** URL segment and stable key: `/apps/<id>`. */
  id: string
  name: string
  description: string
  /** Icon key the frontend maps to a component; unknown keys fall back. */
  icon: string
  /** Full URL loaded into the frame. */
  url: string
  /** Exact origin the frame is expected to post from. */
  origin: string
}

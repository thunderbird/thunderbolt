/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getCorsOriginsList, isOriginAllowed, type Settings } from '@/config/settings'
import cors from '@elysiajs/cors'
import { Elysia } from 'elysia'

type CorsSettings = Pick<Settings, 'corsOrigins' | 'corsAllowCredentials' | 'corsAllowMethods' | 'corsExposeHeaders'>

/** Resolve a request origin using the configured exact-origin CORS policy. */
const resolveCorsOrigin = (
  request: Request,
  settings: Pick<Settings, 'corsOrigins'>,
  allowsAnyOrigin: boolean,
  allowCredentials: boolean,
): string | null => {
  if (allowsAnyOrigin) {
    // Browsers reject wildcard ACAO with credentials, so credentialed wildcard policies must echo Origin.
    return allowCredentials ? request.headers.get('Origin') : '*'
  }

  const origin = request.headers.get('Origin')
  if (origin === null || !isOriginAllowed(origin, settings)) {
    return null
  }
  return origin
}

/** Configure CORS and grant Resource Timing access to the origin CORS resolved for the request. */
export const createCorsMiddleware = (settings: CorsSettings) => {
  const corsOrigins = getCorsOriginsList(settings)
  const allowsAnyOrigin = corsOrigins.includes('*')
  const resolveRequestOrigin = (request: Request) =>
    resolveCorsOrigin(request, settings, allowsAnyOrigin, settings.corsAllowCredentials)
  const corsOrigin =
    allowsAnyOrigin && !settings.corsAllowCredentials
      ? '*'
      : (request: Request) => resolveRequestOrigin(request) !== null

  return new Elysia({ name: 'cors-with-resource-timing' })
    .onRequest(({ request, set }) => {
      const allowedOrigin = resolveRequestOrigin(request)
      if (allowedOrigin === null) {
        return
      }

      // Resource Timing consumes TAO without CORS exposure; timing is revealed only to the CORS-allowed origin.
      set.headers['Timing-Allow-Origin'] = allowedOrigin
    })
    .use(
      cors({
        origin: corsOrigin,
        credentials: settings.corsAllowCredentials,
        methods: settings.corsAllowMethods,
        // Echo back the client's Access-Control-Request-Headers. The universal
        // proxy forwards arbitrary upstream headers as X-Proxy-Passthrough-*.
        allowedHeaders: true,
        exposeHeaders: settings.corsExposeHeaders,
        // Preflights cost ~195ms measured. 10 minutes covers back-to-back chat sends while keeping a
        // CORS policy change from lingering in browser caches (Safari caps around this value anyway).
        maxAge: 600,
      }),
    )
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Identity tokens for Mini Apps.
 *
 * The point of this route is that an embedded app should integrate with **one**
 * issuer — us — rather than with every customer's IdP. However the human signed
 * in (magic link, enterprise OIDC, whatever comes next), the app receives the
 * same short-lived JWT and validates it the same way. That is what keeps
 * onboarding a customer app a config entry rather than an engineering project.
 *
 * Three things are deliberate:
 *
 * 1. **The audience is operator-declared.** It comes from `MINI_APPS[id].origin`
 *    on this side, never from the caller. A client that could name its own `aud`
 *    could mint a token any app would accept.
 *
 * 2. **Secrets are per app.** One shared symmetric key would let any Mini App
 *    forge a token for any other. Asymmetric keys plus a JWKS endpoint are the
 *    upgrade once apps are third-party-built and secret distribution stops being
 *    a deploy-time detail; per-app secrets are the right size until then.
 *
 * 3. **We never hand over the user's Thunderbolt session.** That token's
 *    audience is us. Passing it to an app would be audience confusion, and a
 *    well-built app should reject it anyway.
 */

import { resolveAuthSession, type Auth } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import { getMiniApps, isRequestOriginAllowed, toPublicMiniApps } from '@/config/settings'
import type { User } from '@shared/types/auth'
import { safeErrorHandler } from '@/middleware/error-handling'
import { SignJWT } from 'jose'
import { Elysia, t } from 'elysia'

/**
 * Claims a Mini App can rely on. Kept small: identity, not profile.
 *
 * The registered claims (`sub`, `iss`, `aud`, `iat`, `exp`) are set by `SignJWT`'s
 * builders below, so this type can only enforce the custom half — which it now
 * does via the `satisfies` on the payload. Before that it was documentation
 * pretending to be a contract: renaming a field here changed nothing.
 */
export type MiniAppTokenClaims = {
  /** Thunderbolt user id. */
  sub: string
  email: string
  name: string
  /** The app this token is for — the app MUST check it matches its own origin. */
  aud: string
  iss: string
}

/**
 * `POST /mini-apps/:appId/token` — mint an identity token for one Mini App.
 *
 * Returns 404 for an unknown app rather than 403, because "this deployment has
 * no such app" and "you may not have a token for it" are the same fact here and
 * the distinction would only leak which app ids exist.
 */
export const createMiniAppRoutes = (auth: Auth, settings: Settings) => {
  const apps = getMiniApps(settings)
  /*
   * Derived once, beside the registry it comes from.
   *
   * `getSettings()` memoizes per process, so config cannot change without a
   * restart and there is nothing to recompute — while doing it per request
   * re-parsed `MINI_APPS` and re-logged every malformed entry on each call. This
   * route is unauthenticated, so that turned a startup diagnostic into
   * log volume any caller could drive.
   */
  const publicApps = toPublicMiniApps(apps)

  // Mounted even with an empty registry. Skipping the routes made `GET
  // /mini-apps` 404, which the client cannot tell apart from a network failure
  // — so a deployment that simply runs no apps rendered "Couldn't load your
  // apps. Check your connection," and the provenance banner went silent
  // instead of saying the app is gone. An empty registry is an answer; only an
  // unknown app id is a 404.
  if (apps.size === 0) {
    console.warn('No Mini Apps configured; GET /mini-apps will answer with an empty registry')
  }

  return (
    new Elysia({ prefix: '/mini-apps' })
      .onError(safeErrorHandler)
      /**
       * The registry the frontend renders from — same config as the token route
       * reads, minus the secrets.
       *
       * Unauthenticated on purpose. There is nothing here to protect: the
       * response is `toPublicMiniApps`, which strips every app's secret, and
       * the token route below is what actually guards identity. Session-gating
       * it only cost behaviour — a 403 for anonymous and signed-out callers
       * left the client unable to say "this deployment runs no apps" without
       * inventing a permanent `loading` state, so `/apps/:id` hung blank
       * forever for them.
       *
       * What that gives up is app ids and origins being enumerable by anyone
       * who can reach the deployment. Accepted while the registry is
       * operator-declared config; revisit alongside the first customer
       * deployment, when we know whether naming their apps is sensitive.
       */
      .get('/', () => ({ apps: publicApps }))
      .post(
        '/:appId/token',
        async ({ params, request, set }) => {
          /*
           * Resolved here rather than in a `.derive` on the instance: the
           * registry route above needs no session, and deriving one made every
           * sidebar render pay for an auth lookup it never read.
           *
           * Through `resolveAuthSession`, not `auth.api.getSession` directly —
           * that throws an `APIError` for a rejected credential, which reaches
           * `safeErrorHandler` as a 500 instead of the 401 it should be.
           */
          const session = await resolveAuthSession(auth, request.headers)
          const user = (session?.user as User | undefined) ?? null

          if (!isRequestOriginAllowed(request, settings)) {
            set.status = 403
            return { error: 'Forbidden', code: 'ORIGIN_NOT_ALLOWED' }
          }

          if (!user) {
            set.status = 401
            return { error: 'Unauthorized' }
          }

          // An anonymous user has no identity worth asserting to an app, and an
          // app that trusts `sub` would be trusting a value that changes.
          if (user.isAnonymous) {
            set.status = 403
            return { error: 'Forbidden', code: 'ANONYMOUS_MINI_APP_FORBIDDEN' }
          }

          // `.get`, not an object index: `params.appId` is caller-controlled, and
          // indexing a plain object with it let inherited `Object.prototype` keys
          // pass the guard below (see `getMiniApps`).
          const app = apps.get(params.appId)
          if (!app) {
            set.status = 404
            return { error: 'Unknown Mini App' }
          }

          // Signed with `jose` directly rather than the Elysia JWT plugin: the
          // plugin binds one secret per instance, and every app here signs with
          // its own. Registering a plugin per app to work around that would leave
          // route setup dependent on config, for no gain — this is one call.
          const expiresAt = new Date(Date.now() + settings.miniAppTokenExpirySeconds * 1000)
          const token = await new SignJWT({ email: user.email, name: user.name } satisfies Pick<
            MiniAppTokenClaims,
            'email' | 'name'
          >)
            .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
            .setSubject(user.id)
            .setIssuer(settings.appUrl)
            .setAudience(app.origin)
            .setIssuedAt()
            .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
            .sign(new TextEncoder().encode(app.secret))

          return {
            token,
            // Absolute, not a duration — the guest schedules its refresh against
            // this, and a duration would drift by however long the response took.
            expiresAt: expiresAt.toISOString(),
          }
        },
        { params: t.Object({ appId: t.String() }) },
      )
  )
}

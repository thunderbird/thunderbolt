/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Where a connected user manages or cancels their Tinfoil subscription.
 *
 * The Stripe Customer Portal is reached through the dashboard's Billing tab. The
 * client can't open the portal directly: its URL comes from a Clerk-authed
 * endpoint (`/api/billing/subscriptions`) and the client holds no Clerk session.
 * So "Manage subscription" is a plain outbound link to the dashboard, where the
 * user already has a Tinfoil/Clerk session.
 */
export const tinfoilManageSubscriptionUrl = 'https://dash.tinfoil.sh/?tab=billing'

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { GoogleUserInfo } from '@/integrations/google/types'

/**
 * Tinfoil exposes no userinfo endpoint for the `inference:api` scope, so this is
 * a static identity matching the provider-agnostic {@link GoogleUserInfo} shape
 * the OAuth dispatch layer expects.
 */
export type TinfoilUserInfo = GoogleUserInfo

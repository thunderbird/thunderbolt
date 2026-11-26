/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useServerAuthentication } from '@/hooks/use-local-providers'

/** Choosing a server does not make its managed models usable before sign-in. */
export const useNeedsOwnModel = () => !useServerAuthentication()

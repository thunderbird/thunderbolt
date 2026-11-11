/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { QueryClient } from '@tanstack/react-query'

/** Share request caching between React consumers and non-React chat execution. */
export const queryClient = new QueryClient()

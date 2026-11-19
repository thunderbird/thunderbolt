/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { GlobalRegistrator } from '@happy-dom/global-registrator'

// A real address, so that tests can move around the site with the History API.
GlobalRegistrator.register({ url: 'https://thunderbolt.io/' })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

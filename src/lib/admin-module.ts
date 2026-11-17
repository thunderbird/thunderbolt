/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The one lazy boundary into `admin/` (UNLICENSED). The route and the sidebar both load it here, and
 * nothing else in `src/` may import from `admin/` (enforced by ESLint).
 */
export const loadAdminModule = () => import('../../admin')

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { domMax } from 'framer-motion'

// Re-exported so LazyMotion can load features via dynamic import().
// Keeping this in its own module lets Rollup put domMax (and the feature
// implementations it pulls in) into a separate async chunk that loads
// after first paint, instead of in the entry bundle.
export default domMax

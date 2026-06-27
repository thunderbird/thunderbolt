/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import ReactDOM from 'react-dom/client'
import { App } from './app'
import './polyfills'

// Self-hosted fonts (offline-capable). Variable fonts ship all weights in one file.
import '@fontsource-variable/mona-sans'
import '@fontsource-variable/dm-sans'
import '@fontsource-variable/mozilla-text'
import '@fontsource/space-mono/400.css'
import '@fontsource/space-mono/700.css'

import './index.css'
import { markBundleEvaluated } from './lib/init-timing'
import { initializeLinkInterception } from './lib/intercept-links'
import { handlePostUpdateRedirect } from './lib/post-update-redirect'

// Running here means every static import above (the whole entry bundle) has
// been downloaded, parsed and evaluated — record that phase.
markBundleEvaluated()

// After an update+relaunch, the WebView may restore a stale route (e.g. /waitlist
// verify screen). Detect this and force a clean start at root.
const redirecting = handlePostUpdateRedirect()

if (!redirecting) {
  initializeLinkInterception()

  const root = document.getElementById('root') as HTMLElement

  ReactDOM.createRoot(root).render(<App />)
}

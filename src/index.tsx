/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import ReactDOM from 'react-dom/client'
import { App } from './app'
import './polyfills'

import './index.css'
import { activateLocale, getActiveLocale } from './i18n'
import { markBundleEvaluated } from './lib/init-timing'
import { initializeLinkInterception } from './lib/intercept-links'
import { isMacDesktop, isMobile as isPlatformMobile, isTauri, isTauriDesktop } from './lib/platform'
import { handlePostUpdateRedirect } from './lib/post-update-redirect'

// The macOS desktop window is transparent with a native blur layer behind it
// (see src-tauri/src/lib.rs). This class makes the body transparent and the
// sidebar translucent so the blur shows through — applied before first render
// to avoid a background flash.
if (isMacDesktop()) {
  document.documentElement.classList.add('mac-vibrancy')
}

// The desktop app always uses the desktop layout, however narrow the window
// (the 600px min window width sits below the 640px/768px breakpoints). The
// class drives the sm/md variant overrides and responsive theme variables in
// index.css; useIsMobile (src/hooks/use-mobile.ts) handles the JS side.
if (isTauriDesktop()) {
  document.documentElement.classList.add('force-desktop')
}

// Native mobile (Tauri iOS/Android) pulls the header cluster up toward the
// notch — see the .native-mobile --header-safe-area-top override in index.css.
if (isTauri() && isPlatformMobile()) {
  document.documentElement.classList.add('native-mobile')
}

// Running here means every static import above (the whole entry bundle) has
// been downloaded, parsed and evaluated — record that phase.
markBundleEvaluated()

// Kick off the locale catalog chunk immediately; rendering doesn't wait for it
// (the source locale is active synchronously with per-message English fallback,
// see src/i18n). Activating the boot-seeded locale rather than the source locale
// keeps the localStorage mirror intact — passing `sourceLocale` here would
// overwrite it with `en` on every load — and starts the right catalog fetch
// before the synced setting hydrates. Once it does, useAppLanguage re-activates
// whatever the setting resolves to; until then this is also what `<html lang>`
// reflects (index.html ships the static `lang="en"` as the pre-boot value).
const bootLocale = getActiveLocale()
document.documentElement.lang = bootLocale
void activateLocale(bootLocale)

// After an update+relaunch, the WebView may restore a stale route (e.g. /waitlist
// verify screen). Detect this and force a clean start at root.
const redirecting = handlePostUpdateRedirect()

if (!redirecting) {
  initializeLinkInterception()

  const root = document.getElementById('root') as HTMLElement

  ReactDOM.createRoot(root).render(<App />)
}

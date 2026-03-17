import ReactDOM from 'react-dom/client'
import { App } from './app'
import './polyfills'

import './index.css'
import { initializeLinkInterception } from './lib/intercept-links'
import { handlePostUpdateRedirect } from './lib/post-update-redirect'

// After an update+relaunch, the WebView may restore a stale route (e.g. /waitlist
// verify screen). Detect this and force a clean start at root.
const redirecting = handlePostUpdateRedirect()

if (!redirecting) {
  initializeLinkInterception()

  const root = document.getElementById('root') as HTMLElement

  ReactDOM.createRoot(root).render(<App />)
}

import ReactDOM from 'react-dom/client'
import { App } from './app'
import './polyfills'

import './index.css'
import { initializeLinkInterception } from './lib/intercept-links'
import { ErrorBoundary } from './components/error-boundary'
import { ThemeProvider } from './lib/theme-provider'

initializeLinkInterception()

const root = document.getElementById('root') as HTMLElement

ReactDOM.createRoot(root).render(
  <ThemeProvider defaultTheme="system" storageKey="ui_theme">
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </ThemeProvider>,
)

import ReactDOM from 'react-dom/client'
import { App } from './app'
import './polyfills'

// IMPORTANT: Initialize Flower fetch override before any Flower SDK usage
import './lib/flower-fetch-override'

import './index.css'
import { initializeLinkInterception } from './lib/intercept-links'

initializeLinkInterception()

const root = document.getElementById('root') as HTMLElement

ReactDOM.createRoot(root).render(<App />)

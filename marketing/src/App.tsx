import { ContactPage } from '@/components/sections/contact-page'
import { EnterprisePage } from '@/components/sections/enterprise-page'

const App = () => {
  const path = window.location.pathname.replace(/\/+$/, '') || '/'

  if (path === '/contact') return <ContactPage />
  return <EnterprisePage />
}

export default App

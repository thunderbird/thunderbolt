import { Header } from '@/components/sections/header'
import { Hero } from '@/components/sections/hero'
import { Stats } from '@/components/sections/stats'
import { HowItWorks } from '@/components/sections/how-it-works'
import { Features } from '@/components/sections/features'
import { Enterprise } from '@/components/sections/enterprise'
import { CTA } from '@/components/sections/cta'
import { Footer } from '@/components/sections/footer'

const App = () => (
  <div className="min-h-screen">
    <Header />
    <main>
      <Hero />
      <Stats />
      <HowItWorks />
      <Features />
      <Enterprise />
      <CTA />
    </main>
    <Footer />
  </div>
)

export default App

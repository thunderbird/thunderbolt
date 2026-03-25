import { motion } from 'framer-motion'
import { Menu, X, Zap } from 'lucide-react'
import { useState } from 'react'

export const Header = () => {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <motion.header
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="fixed top-0 right-0 left-0 z-50 border-b border-black/[0.06] bg-white/80 backdrop-blur-xl"
    >
      <div className="flex w-full items-center justify-between px-6 py-4 lg:px-10">
        <a href="#" className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-black">
            <Zap className="size-4 text-white" fill="currentColor" />
          </div>
          <span className="text-lg font-semibold tracking-tight text-black">
            Thunderbolt
          </span>
        </a>

        <nav className="hidden items-center gap-1 md:flex">
          {['Product', 'Solutions', 'Docs', 'Enterprise', 'Pricing'].map(
            (item) => (
              <a
                key={item}
                href={`#${item.toLowerCase()}`}
                className="rounded-md px-3 py-1.5 text-sm text-black/70 transition-colors hover:bg-black/[0.04] hover:text-black"
              >
                {item}
              </a>
            )
          )}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <a
            href="#"
            className="rounded-md border border-black/15 px-4 py-2 font-mono text-xs font-medium tracking-[0.06em] uppercase text-black transition-colors hover:bg-black/[0.04]"
          >
            Book a Demo
          </a>
          <a
            href="#"
            className="rounded-md bg-black px-4 py-2 font-mono text-xs font-medium tracking-[0.06em] uppercase text-white transition-colors hover:bg-black/85"
          >
            Try for Free
          </a>
        </div>

        <button className="md:hidden" onClick={() => setMobileOpen(!mobileOpen)}>
          {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>

      {mobileOpen && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="border-t border-black/[0.06] bg-white px-6 pb-6 md:hidden"
        >
          <nav className="flex flex-col gap-3 pt-4">
            {['Product', 'Solutions', 'Docs', 'Enterprise', 'Pricing'].map(
              (item) => (
                <a
                  key={item}
                  href={`#${item.toLowerCase()}`}
                  className="text-sm text-black/70"
                  onClick={() => setMobileOpen(false)}
                >
                  {item}
                </a>
              )
            )}
            <a
              href="#"
              className="mt-2 rounded-md bg-black px-4 py-2.5 text-center font-mono text-xs font-medium tracking-[0.06em] uppercase text-white"
            >
              Try for Free
            </a>
          </nav>
        </motion.div>
      )}
    </motion.header>
  )
}

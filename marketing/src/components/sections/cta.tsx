import { motion } from 'framer-motion'
import { Zap } from 'lucide-react'

export const CTA = () => (
  <section className="border-t border-black/[0.06]">
    <div className="w-full px-6 py-24 md:py-32 lg:px-10">
      <motion.div
        initial={{ opacity: 0, y: 32 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6, ease: [0.21, 0.47, 0.32, 0.98] as const }}
        className="relative overflow-hidden rounded-3xl bg-black px-8 py-20 md:px-20 md:py-28"
      >
        {/* Gradient glow */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-40 left-1/3 h-80 w-80 rounded-full bg-cyan-500/20 blur-[100px]" />
          <div className="absolute -bottom-40 right-1/3 h-80 w-80 rounded-full bg-fuchsia-500/20 blur-[100px]" />
        </div>

        <div className="relative flex flex-col items-start gap-12 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-6 flex size-14 items-center justify-center rounded-2xl bg-white/10">
              <Zap className="size-7 text-white" fill="currentColor" />
            </div>
            <h2 className="text-[clamp(2rem,3.5vw,3.5rem)] leading-[1.08] font-medium tracking-[-0.035em] text-white">
              Ready to take control
              <br />
              of your AI?
            </h2>
            <p className="mt-5 max-w-lg text-lg leading-relaxed text-white/50">
              Join the teams that refuse to compromise on privacy. Get early
              access to Thunderbolt and deploy AI on your terms.
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap gap-3">
            <a
              href="#"
              className="rounded-md border border-white/20 px-6 py-3 font-mono text-xs font-medium tracking-[0.06em] uppercase text-white transition-colors hover:bg-white/10"
            >
              Book a Demo
            </a>
            <a
              href="#"
              className="rounded-md bg-white px-6 py-3 font-mono text-xs font-medium tracking-[0.06em] uppercase text-black transition-colors hover:bg-white/90"
            >
              Try for Free
            </a>
          </div>
        </div>

        <p className="relative mt-12 font-mono text-xs tracking-wider text-white/25 uppercase">
          Open source &middot; Self-hostable &middot; Free to start
        </p>
      </motion.div>
    </div>
  </section>
)

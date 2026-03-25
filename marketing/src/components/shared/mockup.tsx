import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

type MockupProps = {
  children: ReactNode
  className?: string
}

export const Mockup = ({ children, className = '' }: MockupProps) => (
  <motion.div
    initial={{ opacity: 0, y: 40, scale: 0.97 }}
    whileInView={{ opacity: 1, y: 0, scale: 1 }}
    viewport={{ once: true, margin: '-60px' }}
    transition={{ duration: 0.7, ease: [0.21, 0.47, 0.32, 0.98] }}
    className={`overflow-hidden rounded-xl border border-border bg-white shadow-2xl shadow-black/5 ${className}`}
  >
    {/* Window chrome */}
    <div className="flex items-center gap-2 border-b border-border/60 bg-surface-secondary px-4 py-3">
      <div className="size-3 rounded-full bg-red-400/70" />
      <div className="size-3 rounded-full bg-yellow-400/70" />
      <div className="size-3 rounded-full bg-green-400/70" />
      <div className="ml-3 h-5 flex-1 rounded-md bg-border/50" />
    </div>
    <div className="p-0">{children}</div>
  </motion.div>
)

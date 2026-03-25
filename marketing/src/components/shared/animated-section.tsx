import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

type AnimatedSectionProps = {
  children: ReactNode
  className?: string
  delay?: number
}

export const AnimatedSection = ({
  children,
  className = '',
  delay = 0,
}: AnimatedSectionProps) => (
  <motion.div
    initial={{ opacity: 0, y: 32 }}
    whileInView={{ opacity: 1, y: 0 }}
    viewport={{ once: true, margin: '-80px' }}
    transition={{ duration: 0.6, delay, ease: [0.21, 0.47, 0.32, 0.98] }}
    className={className}
  >
    {children}
  </motion.div>
)

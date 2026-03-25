import { motion } from 'framer-motion'

const stats = [
  { value: '0', unit: '', label: 'Server logs stored' },
  { value: '0', unit: '', label: 'Data used for training' },
  { value: '100', unit: '%', label: 'On-device storage' },
  { value: 'E2E', unit: '', label: 'Encrypted sync' },
]

export const Stats = () => (
  <section className="bg-black py-20 md:py-28">
    <div className="w-full px-6 lg:px-10">
      <div className="grid grid-cols-2 gap-y-12 md:grid-cols-4">
        {stats.map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.1, duration: 0.5 }}
            className="text-center"
          >
            <div className="font-mono text-[clamp(2.5rem,4vw,4.5rem)] font-bold leading-none tracking-tight text-white">
              {stat.value}
              <span className="text-white/40">{stat.unit}</span>
            </div>
            <p className="mt-3 font-mono text-xs tracking-[0.08em] uppercase text-white/40">
              {stat.label}
            </p>
          </motion.div>
        ))}
      </div>
    </div>
  </section>
)

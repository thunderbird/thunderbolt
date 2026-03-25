import { motion } from 'framer-motion'
import { SectionHeading } from '@/components/shared/section-heading'

const steps = [
  {
    step: '01',
    title: 'Deploy or download',
    description:
      'Self-host with Docker or grab the native app for macOS, Windows, Linux, iOS, or Android.',
  },
  {
    step: '02',
    title: 'Connect your models',
    description:
      'Add API keys for any LLM provider — Anthropic, OpenAI, OpenRouter, or your own endpoint. Keys stay on your device.',
  },
  {
    step: '03',
    title: 'Start working',
    description:
      'Chat, manage email, review documents, and automate workflows. Everything syncs across your devices, encrypted end-to-end.',
  },
]

export const HowItWorks = () => (
  <section className="py-24 md:py-32">
    <div className="w-full px-6 lg:px-10">
      <SectionHeading
        label="How It Works"
        title="From zero to productive in minutes"
        description="No complex setup. No vendor meetings. No procurement cycles."
      />

      <div className="mt-16 grid gap-px overflow-hidden rounded-2xl border border-black/[0.06] bg-black/[0.06] md:grid-cols-3">
        {steps.map((step, i) => (
          <motion.div
            key={step.step}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{
              delay: i * 0.12,
              duration: 0.5,
              ease: [0.21, 0.47, 0.32, 0.98] as const,
            }}
            className="bg-white p-8 md:p-10"
          >
            <span className="font-mono text-4xl font-bold tracking-tight text-black/[0.06]">
              {step.step}
            </span>
            <h3 className="mt-6 text-xl font-medium tracking-tight text-black">
              {step.title}
            </h3>
            <p className="mt-3 leading-relaxed text-black/50">
              {step.description}
            </p>
          </motion.div>
        ))}
      </div>
    </div>
  </section>
)

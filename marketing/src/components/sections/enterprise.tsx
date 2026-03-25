import { motion } from 'framer-motion'
import {
  Building2,
  Clock,
  Globe,
  Lock,
  MonitorSmartphone,
  Users,
} from 'lucide-react'
import { SectionHeading } from '@/components/shared/section-heading'

const cards = [
  {
    icon: Lock,
    title: 'Zero-Knowledge Architecture',
    description:
      'We never see your conversations. Data is encrypted at rest on-device and in transit to your chosen LLM provider. Our servers are never in the loop.',
  },
  {
    icon: Building2,
    title: 'Data Residency Control',
    description:
      'Self-host in any region. Meet GDPR, HIPAA, and internal compliance requirements by keeping everything within your infrastructure boundary.',
  },
  {
    icon: Users,
    title: 'Team Management',
    description:
      'SSO via SAML and OIDC. Centralized model configuration, usage policies, and device management for your entire organization.',
  },
  {
    icon: MonitorSmartphone,
    title: 'Cross-Platform Native',
    description:
      'Desktop apps for macOS, Windows, and Linux. Mobile for iOS and Android. All powered by the same local-first sync engine.',
  },
  {
    icon: Globe,
    title: 'Open Source',
    description:
      'Fully auditable codebase. No black boxes, no proprietary lock-in. Fork it, extend it, contribute back.',
  },
  {
    icon: Clock,
    title: 'Offline-First',
    description:
      'Works without internet. Conversations sync automatically when connectivity returns. No productivity lost.',
  },
]

export const Enterprise = () => (
  <section id="enterprise" className="py-24 md:py-32">
    <div className="w-full px-6 lg:px-10">
      <SectionHeading
        label="Enterprise"
        title="Built for organizations that take security seriously"
        description="Thunderbolt gives your team AI superpowers without compromising on the security and compliance standards you've worked hard to build."
      />

      <div className="mt-16 grid gap-px overflow-hidden rounded-2xl border border-black/[0.06] bg-black/[0.06] sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card, i) => {
          const Icon = card.icon
          return (
            <motion.div
              key={card.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.06, duration: 0.5 }}
              className="group bg-white p-8 transition-colors hover:bg-neutral-50 md:p-10"
            >
              <div className="flex size-12 items-center justify-center rounded-xl bg-black/[0.03] text-black/40 transition-colors group-hover:bg-black group-hover:text-white">
                <Icon className="size-5" />
              </div>
              <h3 className="mt-5 text-lg font-medium tracking-tight text-black">
                {card.title}
              </h3>
              <p className="mt-2 leading-relaxed text-black/50">
                {card.description}
              </p>
            </motion.div>
          )
        })}
      </div>
    </div>
  </section>
)

import { motion } from 'framer-motion'
import {
  Brain,
  KeyRound,
  Mail,
  Server,
  Shield,
  Workflow,
} from 'lucide-react'
import { useState } from 'react'
import { SectionHeading } from '@/components/shared/section-heading'
import { Mockup } from '@/components/shared/mockup'

const features = [
  {
    icon: Shield,
    label: 'Privacy by Design',
    title: 'Your conversations never leave your device',
    description:
      'All data is stored locally using encrypted SQLite. No telemetry, no analytics, no server-side logging. Your conversations are yours alone.',
    mockup: 'privacy' as const,
  },
  {
    icon: Brain,
    label: 'Bring Your Own Model',
    title: 'Use any LLM provider you trust',
    description:
      'Connect Anthropic, OpenAI, OpenRouter, or any OpenAI-compatible endpoint. Swap models mid-conversation. Your API keys never touch our servers.',
    mockup: 'models' as const,
  },
  {
    icon: Mail,
    label: 'Smart Integrations',
    title: 'Email, calendar, and documents — all connected',
    description:
      'Connect Google and Microsoft accounts to manage email, review calendars, and search documents. All processing happens on-device.',
    mockup: 'integrations' as const,
  },
  {
    icon: Server,
    label: 'Self-Hosted',
    title: 'Deploy on your own infrastructure',
    description:
      'Run the entire stack on your servers. Full control over data residency, compliance, and access policies. Docker-ready in minutes.',
    mockup: 'deploy' as const,
  },
]

export const Features = () => {
  const [active, setActive] = useState(0)
  const f = features[active]

  return (
    <section id="features" className="border-t border-black/[0.06] bg-neutral-50 py-24 md:py-32">
      <div className="w-full px-6 lg:px-10">
        <SectionHeading
          label="Features"
          title="Enterprise AI that respects your boundaries"
          description="Every feature built with a single principle: your data belongs to you."
        />

        <div className="mt-16 grid gap-10 lg:grid-cols-[400px_1fr] lg:gap-6">
          {/* Tabs */}
          <div className="flex flex-col gap-1">
            {features.map((feature, i) => {
              const Icon = feature.icon
              const isActive = i === active
              return (
                <button
                  key={feature.label}
                  onClick={() => setActive(i)}
                  className={`group flex items-start gap-4 rounded-xl p-5 text-left transition-all duration-200 ${
                    isActive
                      ? 'bg-white shadow-sm ring-1 ring-black/[0.06]'
                      : 'hover:bg-white/60'
                  }`}
                >
                  <div
                    className={`flex size-10 shrink-0 items-center justify-center rounded-lg transition-colors ${
                      isActive
                        ? 'bg-black text-white'
                        : 'bg-black/[0.04] text-black/40 group-hover:text-black/60'
                    }`}
                  >
                    <Icon className="size-5" />
                  </div>
                  <div>
                    <h3
                      className={`font-medium ${
                        isActive ? 'text-black' : 'text-black/70'
                      }`}
                    >
                      {feature.label}
                    </h3>
                    <p className="mt-0.5 text-sm text-black/40">
                      {feature.title}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>

          {/* Mockup + description */}
          <div>
            <motion.div
              key={active}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: [0.21, 0.47, 0.32, 0.98] as const }}
            >
              <Mockup>
                <FeatureMockup type={f.mockup} />
              </Mockup>
              <div className="mt-8">
                <h3 className="text-2xl font-medium tracking-tight text-black">
                  {f.title}
                </h3>
                <p className="mt-2 max-w-lg leading-relaxed text-black/50">
                  {f.description}
                </p>
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Mockup internals                                                   */
/* ------------------------------------------------------------------ */

const FeatureMockup = ({ type }: { type: string }) => {
  switch (type) {
    case 'privacy':
      return <PrivacyMockup />
    case 'models':
      return <ModelsMockup />
    case 'integrations':
      return <IntegrationsMockup />
    case 'deploy':
      return <DeployMockup />
    default:
      return null
  }
}

const PrivacyMockup = () => (
  <div className="space-y-4 p-6">
    <div className="flex items-center gap-3 rounded-lg bg-emerald-50 p-4">
      <Shield className="size-5 text-emerald-600" />
      <div>
        <div className="text-sm font-medium text-emerald-900">
          Data Protection Active
        </div>
        <div className="text-xs text-emerald-600">
          All conversations encrypted and stored locally
        </div>
      </div>
    </div>
    <div className="grid grid-cols-2 gap-3">
      {[
        { label: 'Server Logs', value: 'None', color: 'text-emerald-600' },
        { label: 'Training Data', value: 'Never', color: 'text-emerald-600' },
        { label: 'Storage', value: 'On-Device', color: 'text-black' },
        { label: 'Encryption', value: 'AES-256', color: 'text-black' },
      ].map((item) => (
        <div key={item.label} className="rounded-lg bg-neutral-50 p-3">
          <div className="text-xs text-black/40">{item.label}</div>
          <div className={`mt-1 font-mono text-sm font-semibold ${item.color}`}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
    <div className="rounded-lg bg-neutral-50 p-4">
      <div className="text-xs font-medium text-black/40">Data Flow</div>
      <div className="mt-3 flex items-center gap-2 text-xs">
        <div className="rounded-md bg-black px-3 py-2 font-medium text-white">
          Your Device
        </div>
        <div className="flex-1 border-t-2 border-dashed border-emerald-300" />
        <div className="rounded-md bg-emerald-100 px-3 py-2 font-medium text-emerald-700">
          LLM Provider
        </div>
        <div className="relative flex-1 border-t-2 border-dashed border-red-300">
          <span className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-600">
            No data stored
          </span>
        </div>
        <div className="rounded-md bg-neutral-100 px-3 py-2 font-medium text-black/30 line-through">
          Our Servers
        </div>
      </div>
    </div>
  </div>
)

const ModelsMockup = () => (
  <div className="space-y-3 p-6">
    <div className="flex items-center justify-between">
      <div className="font-medium text-black">Your Models</div>
      <div className="rounded-md bg-black px-2.5 py-1 text-xs font-medium text-white">
        + Add Model
      </div>
    </div>
    {[
      { name: 'Claude 3.5 Sonnet', provider: 'Anthropic', color: 'bg-orange-500' },
      { name: 'GPT-4o', provider: 'OpenAI', color: 'bg-emerald-500' },
      { name: 'Llama 3.1 70B', provider: 'OpenRouter', color: 'bg-purple-500' },
      { name: 'Mistral Large', provider: 'Custom Endpoint', color: 'bg-blue-500' },
    ].map((model) => (
      <div
        key={model.name}
        className="flex items-center gap-3 rounded-lg bg-neutral-50 p-3"
      >
        <div className={`size-3 rounded-full ${model.color}`} />
        <div className="flex-1">
          <div className="text-sm font-medium text-black">{model.name}</div>
          <div className="text-xs text-black/40">{model.provider}</div>
        </div>
        <div className="flex items-center gap-1.5 font-mono text-xs text-emerald-600">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          Active
        </div>
      </div>
    ))}
    <div className="rounded-lg border border-dashed border-black/10 p-3 text-center text-xs text-black/40">
      API keys stored locally — never sent to Thunderbolt servers
    </div>
  </div>
)

const IntegrationsMockup = () => (
  <div className="space-y-3 p-6">
    <div className="font-medium text-black">Connected Accounts</div>
    {[
      { name: 'Google Workspace', scope: 'Email, Calendar, Drive', dot: 'bg-blue-500' },
      { name: 'Microsoft 365', scope: 'Outlook, Calendar, OneDrive', dot: 'bg-sky-600' },
    ].map((account) => (
      <div
        key={account.name}
        className="flex items-center gap-3 rounded-lg bg-neutral-50 p-3"
      >
        <div className={`size-3 rounded-full ${account.dot}`} />
        <div className="flex-1">
          <div className="text-sm font-medium text-black">{account.name}</div>
          <div className="text-xs text-black/40">{account.scope}</div>
        </div>
        <div className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
          Connected
        </div>
      </div>
    ))}
    <div className="rounded-lg bg-neutral-50 p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-black">
        <Workflow className="size-4 text-black/40" />
        Recent Activity
      </div>
      <div className="mt-3 space-y-2">
        {[
          'Summarized 3 unread threads from marketing team',
          'Created calendar block for focus time tomorrow',
          'Found Q4 budget spreadsheet in Drive',
        ].map((activity) => (
          <div key={activity} className="flex items-start gap-2 text-xs text-black/50">
            <span className="mt-1.5 size-1 shrink-0 rounded-full bg-black/20" />
            {activity}
          </div>
        ))}
      </div>
    </div>
  </div>
)

const DeployMockup = () => (
  <div className="space-y-4 p-6">
    <div className="rounded-lg bg-[#0d1117] p-5 font-mono text-xs leading-relaxed text-emerald-400">
      <div className="text-white/30"># Deploy Thunderbolt in minutes</div>
      <div className="mt-2">
        <span className="text-cyan-400">$</span> docker compose up -d
      </div>
      <div className="mt-1 text-emerald-400/70">
        ✓ Backend server started on :3000
      </div>
      <div className="text-emerald-400/70">✓ PostgreSQL connected</div>
      <div className="text-emerald-400/70">✓ PowerSync configured</div>
      <div className="text-emerald-400/70">✓ Migrations applied (12 tables)</div>
      <div className="mt-2">
        <span className="text-cyan-400">$</span> thunderbolt status
      </div>
      <div className="mt-1 text-emerald-400">
        ⚡ Thunderbolt v1.0 running — 0 external dependencies
      </div>
    </div>
    <div className="grid grid-cols-3 gap-3">
      {[
        { icon: KeyRound, label: 'SSO / SAML', desc: 'Enterprise auth' },
        { icon: Server, label: 'On-Prem', desc: 'Your infrastructure' },
        { icon: Shield, label: 'Compliance', desc: 'SOC 2 ready' },
      ].map((item) => (
        <div key={item.label} className="rounded-lg bg-neutral-50 p-3 text-center">
          <item.icon className="mx-auto size-5 text-black/40" />
          <div className="mt-2 text-xs font-medium text-black">{item.label}</div>
          <div className="text-[10px] text-black/40">{item.desc}</div>
        </div>
      ))}
    </div>
  </div>
)

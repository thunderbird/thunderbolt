import { Blocks, Factory, Globe, Heart, MapPin, ScanLine, Signpost, Zap } from 'lucide-react'

/* ─── Shared ──────────────────────────────────────────── */

const GetStartedButton = () => (
  <a
    href="https://thunderbolt.so"
    className="inline-flex h-[46px] w-[131px] items-center justify-center bg-[#344054] font-mono text-sm font-bold uppercase tracking-wider text-white transition-colors hover:bg-[#344054]/90"
  >
    Get Started
  </a>
)

/* ─── Background Grid ─────────────────────────────────── */

const BackgroundGrid = () => (
  <div className="pointer-events-none absolute inset-0 z-0 hidden overflow-hidden lg:block" aria-hidden="true">
    {/* 8 vertical grid lines, 1120px wide centered, 160px apart */}
    <div className="absolute inset-y-0 left-1/2 w-[1120px] -translate-x-1/2">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div key={i} className="absolute inset-y-0 w-px bg-[#eaecf0]/60" style={{ left: i * 160 }} />
      ))}
    </div>
    {/* Decorative squares positioned on the 1440px canvas */}
    <div className="absolute left-1/2 top-0 w-[1440px] -translate-x-1/2">
      <div className="absolute left-[321px] top-[439px] size-[160px] bg-[#eff1f4]" />
      <div className="absolute left-[241px] top-[358px] size-[80px] bg-[#eff1f4]" />
      <div className="absolute right-0 top-[358px] size-[160px] bg-[#eff1f4]" />
      <div className="absolute left-0 top-[599px] size-[160px] bg-[#eff1f4]" />
      <div className="absolute right-[80px] top-[679px] size-[80px] bg-[#eff1f4]" />
      <div className="absolute left-[1121px] top-[519px] size-[160px] bg-[#eff1f4]" />
    </div>
  </div>
)

/* ─── Header ──────────────────────────────────────────── */

const Header = () => (
  <header className="fixed inset-x-0 top-0 z-50 h-[104px] bg-white/20 backdrop-blur-[32px]">
    <div className="mx-auto flex h-full max-w-[1440px] items-center justify-between px-6 lg:px-[160px]">
      <div className="flex items-center gap-2">
        <a href="/" className="flex items-center gap-[7px]">
          <Zap className="size-[23px] fill-[#101828] text-[#101828]" />
          <span className="text-xl font-medium leading-7 tracking-[-0.4px] text-[#101828]">Thunderbolt</span>
        </a>
        <span className="flex items-center gap-0.5 font-mono text-sm font-bold uppercase text-[#344054]">
          [<Factory className="inline size-4 text-[#3888d0]" />enterprises]
        </span>
      </div>
      <GetStartedButton />
    </div>
  </header>
)

/* ─── Hero ────────────────────────────────────────────── */

const Hero = () => (
  <section className="relative pt-[80px]">
    <div className="mx-auto flex max-w-[730px] flex-col items-center gap-6 px-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-[40px] font-medium leading-[1.1] tracking-[-0.96px] text-[#101828] md:text-[48px]">
          AI You Control
        </h1>
        <p className="max-w-[718px] text-lg leading-[1.2] text-[#667085] md:text-2xl">
          The Open-Source, Cross-Platform, Extensible AI Workspace
        </p>
      </div>
      <GetStartedButton />
    </div>
    {/* Device mockups — SVG exported from Figma */}
    <div className="mx-auto mt-10 max-w-[1120px] px-6 lg:px-0">
      <img src="/enterprise/hero-mockup.png" alt="Thunderbolt on desktop and mobile" className="w-full" />
    </div>
  </section>
)

/* ─── Feature Cards ───────────────────────────────────── */

const FeatureCards = () => (
  <section className="relative">
    <div className="mx-auto grid max-w-[1120px] gap-[6px] px-6 md:grid-cols-3 lg:px-0">
      {/* Control Your Data */}
      <div className="flex h-[360px] flex-col justify-end border-[0.5px] border-[#eaecf0] bg-white/10 px-8 pb-8 backdrop-blur-[7px]">
        <div className="relative mb-4 h-[180px] w-[181px]">
          <div className="absolute left-[40px] top-[20px] h-[185px] w-[134px] rounded-[67px] bg-[#98a2b3] opacity-70 blur-[25px]" />
          <img src="/enterprise/control-data.png" alt="" className="relative size-full object-contain object-bottom" />
        </div>
        <h3 className="text-2xl font-medium leading-8 tracking-[-0.48px] text-[#101828]">Control Your Data</h3>
        <p className="mt-2 text-base leading-6 text-[#667085]">
          Self-host on your infrastructure or let us help you deploy. Your data never leaves your control.
        </p>
      </div>

      {/* Choose Any Agent (or Model) */}
      <div className="relative flex flex-col overflow-visible border-[0.5px] border-[#eaecf0] bg-white/10 px-8 pt-8 pb-8 backdrop-blur-sm">
        <h3 className="text-2xl font-medium leading-8 tracking-[-0.48px] text-[#101828]">
          Choose Any Agent<br />(or Model)
        </h3>
        <p className="mt-2 text-base leading-6 text-[#667085]">
          Connect any ACP-compatible agent or OpenAI-compatible model - Claude, Codex, OpenClaw, Deepset, OpenCode, OpenAI, etc.
        </p>
        {/* Model logos — sine wave layout from Figma Group 42 */}
        <div className="relative -ml-[55px] mt-4 h-[173px] w-[402px]">
          {[
            { src: '/enterprise/chatgpt.png', alt: 'ChatGPT', size: 38, x: 0, y: 23 },
            { src: '/enterprise/anthropic.png', alt: 'Anthropic', size: 48, x: 80, y: 88 },
            { src: '/enterprise/gemini.png', alt: 'Gemini', size: 32, x: 158, y: 42 },
            { src: '/enterprise/mistral-logo.png', alt: 'Mistral', size: 22, x: 238, y: 0 },
            { src: '/enterprise/meta.png', alt: 'Meta', size: 32, x: 317, y: 34 },
          ].map((logo) => (
            <div
              key={logo.alt}
              className="absolute flex size-[85px] items-center justify-center border border-[#eaecf0] bg-gradient-to-b from-white/[0.01] to-white/[0.19] shadow-[0px_0px_14px_0px_rgba(0,0,0,0.05)] backdrop-blur-[5px]"
              style={{ left: logo.x, top: logo.y }}
            >
              <img src={logo.src} alt={logo.alt} style={{ width: logo.size, height: logo.size }} className="object-contain" />
            </div>
          ))}
        </div>
      </div>

      {/* Built for Enterprise */}
      <div className="flex h-[360px] flex-col border-[0.5px] border-[#eaecf0] bg-white/10 px-8 pt-8 backdrop-blur-[5px]">
        <h3 className="text-2xl font-medium leading-8 tracking-[-0.48px] text-[#101828]">Built for Enterprise</h3>
        <p className="mt-2 text-base leading-6 text-[#667085]">
          Native apps across web, desktop, and mobile. MCP integration with your systems. Forward-Deployed Engineering from trusted partners. Open source you can audit and customize as your business needs evolve.
        </p>
      </div>
    </div>
  </section>
)

/* ─── AI Without Compromise ───────────────────────────── */

const features = [
  { icon: Blocks, color: '#aab927', title: 'Extensible', desc: 'MCP support, custom integrations, full API' },
  { icon: MapPin, color: '#8be0ff', title: 'Data Sovereignty', desc: 'On-prem, sovereign cloud, or air-gapped' },
  { icon: ScanLine, color: '#ff929f', title: 'Automations', desc: 'Reusable workflows for recurring tasks' },
  { icon: Globe, color: '#d792ff', title: 'European Delivery', desc: 'Trusted partners for sovereign deployments' },
  { icon: Heart, color: '#73bafd', title: 'All Platforms', desc: 'Web, Windows, macOS, Linux, iOS, Android' },
  { icon: Signpost, color: '#73bafd', title: 'Model + Agent Agnostic', desc: 'Connect any ACP-compatible agent or AI-compatible model' },
]

const CompromiseSection = () => (
  <section className="pt-24">
    <div className="mx-auto max-w-[1120px] px-6 lg:px-0">
      <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
        <div>
          <p className="text-sm uppercase tracking-[-0.28px] text-[#667085]">
            Open Source &bull; Self Hosted &bull; Enterprise-Ready
          </p>
          <h2 className="mt-2 text-[32px] font-medium leading-[1.2] tracking-[-0.8px] text-[#101828] md:text-[40px]">
            AI Without Compromise
          </h2>
          <p className="mt-1 max-w-[487px] text-base leading-6 text-[#667085]">
            Thunderbolt gives enterprises complete control over AI infrastructure without sacrificing capability.
          </p>
        </div>
        <GetStartedButton />
      </div>
      <div className="mt-6 grid gap-2 md:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="flex h-[144px] flex-col border border-[#d0d5dd]/50 bg-[#f9fafb]/30 p-4 shadow-[0px_7px_12px_0px_rgba(0,0,0,0.07)] backdrop-blur-[1px]">
            <f.icon className="size-6" style={{ color: f.color }} />
            <h3 className="mt-4 text-lg font-semibold leading-7 text-[#101828]">{f.title}</h3>
            <p className="mt-0.5 text-sm leading-5 text-[#667085]">{f.desc}</p>
          </div>
        ))}
      </div>
    </div>
  </section>
)

/* ─── Quote Section ───────────────────────────────────── */

const QuoteSection = () => (
  <section className="py-24">
    <div className="mx-auto max-w-[1120px] px-6 lg:px-0">
      <div className="flex items-start gap-3">
        <Factory className="mt-0.5 size-6 shrink-0 text-[#3888d0]" />
        <p className="text-lg uppercase tracking-[-0.36px] text-[#667085]">
          Trusted by Organizations That Can't Compromise
        </p>
      </div>
      <div className="mt-8 border border-[#d0d5dd] bg-white p-10 shadow-[0px_48px_100px_0px_rgba(17,12,46,0.15)] md:ml-[320px]">
        <p className="text-[32px] font-medium leading-[1.2] tracking-[-1.12px] text-[#101828] md:text-[56px]">
          &ldquo;Organizations across sectors are recognizing that AI is too strategic to outsource.&rdquo;
        </p>
        <p className="mt-6 text-xl font-bold leading-7 tracking-[-0.4px] text-[#667085]">
          Ryan Sipes,<br />CEO, Mozilla Thunderbird
        </p>
      </div>
    </div>
  </section>
)

/* ─── CTA Section ─────────────────────────────────────── */

const CTASection = () => (
  <section className="py-24">
    <div className="mx-auto max-w-[737px] px-6 text-center">
      <Zap className="mx-auto size-6 text-[#101828]" />
      <h2 className="mt-2 text-[32px] font-medium leading-[1.2] tracking-[-0.96px] text-[#101828] md:text-[48px]">
        Ready to Take Control?
      </h2>
      <p className="mx-auto mt-2 max-w-[567px] text-base leading-6 text-[#667085]">
        Start with a pilot deployment or talk to our enterprise team about Forward-Deployed Engineering and sovereign infrastructure.
      </p>
      <div className="mt-6">
        <GetStartedButton />
      </div>
    </div>
  </section>
)

/* ─── Footer ──────────────────────────────────────────── */

const FooterSection = () => (
  <footer className="pb-16">
    <div className="mx-auto max-w-[1120px] px-6 lg:px-0">
      <div className="flex items-center justify-center gap-2">
        <Zap className="size-[34px] fill-[#101828] text-[#101828]" />
        <span className="text-xl font-medium tracking-tight text-[#101828]">Thunderbolt</span>
      </div>
      <div className="mx-auto mt-6 h-px max-w-[1118px] bg-[#eaecf0]" />
      <div className="mt-6 flex flex-col items-center justify-center gap-4 text-center md:flex-row md:gap-[60px]">
        <img src="/enterprise/mozilla-logo.svg" alt="Mozilla" className="h-6 w-auto" />
        <p className="max-w-[638px] text-xs leading-4 text-[#667085]">
          Thunderbolt is part of{' '}
          <a href="https://blog.thunderbird.net/2020/01/thunderbirds-new-home/" className="underline" target="_blank" rel="noopener noreferrer">
            MZLA Technologies Corporation
          </a>
          , a wholly owned subsidiary of Mozilla Foundation. Portions of this content are &copy;1998&ndash;2026 by individual contributors. Content available under a{' '}
          <a href="https://www.mozilla.org/foundation/licensing/website-content/" className="underline" target="_blank" rel="noopener noreferrer">
            Creative Commons license
          </a>
          .
        </p>
      </div>
    </div>
  </footer>
)

/* ─── Page ────────────────────────────────────────────── */

export const EnterprisePage = () => (
  <div className="relative min-h-screen bg-[#f9fafb]">
    <BackgroundGrid />
    <Header />
    <main className="relative pt-[104px]">
      <Hero />
      <FeatureCards />
      <CompromiseSection />
      <QuoteSection />
      <CTASection />
    </main>
    <FooterSection />
  </div>
)

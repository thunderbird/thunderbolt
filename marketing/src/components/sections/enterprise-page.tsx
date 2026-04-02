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
          <img src="/enterprise/thunderbolt-logo.svg" alt="Thunderbolt" className="size-[23px]" />
          <span className="text-xl font-medium leading-7 tracking-[-0.4px] text-[#101828]">Thunderbolt</span>
        </a>
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
    {/* Corner dots at grid intersections — hidden on mobile */}
    <div className="pointer-events-none absolute inset-x-0 top-0 hidden lg:block" aria-hidden="true">
      <div className="mx-auto relative max-w-[1440px]">
        {/* Top row */}
        {[
          { l: 155, t: -4 }, { l: 525, t: -4 }, { l: 525, t: -75 }, { l: 905, t: -75 },
          { l: 905, t: -4 }, { l: 1274, t: -4 },
          /* Bottom row */
          { l: 155, t: 355 }, { l: 525, t: 355 }, { l: 525, t: 289 },
          { l: 905, t: 354 }, { l: 1274, t: 354 },
        ].map((d, i) => (
          <div key={i} className="absolute size-3 bg-[#eaecf0]" style={{ left: d.l, top: d.t }} />
        ))}
      </div>
    </div>
    <div className="mx-auto grid max-w-[1120px] gap-0 px-6 md:grid-cols-3 lg:px-0">
      {/* Control Your Data */}
      <div className="flex flex-col justify-end border-[0.5px] border-[#eaecf0]/50 bg-white/5 px-8 pb-8 backdrop-blur-[7px] md:h-[360px]">
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
      <div className="relative flex flex-col overflow-visible border-[0.5px] border-[#eaecf0]/50 bg-white/5 px-8 pt-8 pb-8 backdrop-blur-sm">
        <h3 className="text-2xl font-medium leading-8 tracking-[-0.48px] text-[#101828]">
          Choose Any Agent<br />(or Model)
        </h3>
        <p className="mt-2 text-base leading-6 text-[#667085]">
          Connect any ACP-compatible agent or OpenAI-compatible model - Claude, Codex, OpenClaw, Deepset, OpenCode, OpenAI, etc.
        </p>
        {/* Model logos — sine wave layout from Figma Group 42 */}
        <div className="relative -ml-[55px] mt-4 h-[173px] w-[402px]">
          {[
            { src: '/enterprise/chatgpt.png', alt: 'ChatGPT', size: 38, x: 0, y: 23, z: 3 },
            { src: '/enterprise/anthropic.png', alt: 'Anthropic', size: 48, x: 80, y: 88, z: 1 },
            { src: '/enterprise/gemini.png', alt: 'Gemini', size: 32, x: 158, y: 42, z: 5 },
            { src: '/enterprise/mistral-logo.png', alt: 'Mistral', size: 22, x: 238, y: 0, z: 4 },
            { src: '/enterprise/meta.png', alt: 'Meta', size: 32, x: 317, y: 34, z: 2 },
          ].map((logo) => (
            <div
              key={logo.alt}
              className="absolute flex size-[85px] items-center justify-center border border-[#eaecf0] bg-[#f9fafb] shadow-[0px_0px_14px_0px_rgba(0,0,0,0.05)]"
              style={{ left: logo.x, top: logo.y, zIndex: logo.z }}
            >
              <img src={logo.src} alt={logo.alt} style={{ width: logo.size, height: logo.size }} className="object-contain" />
            </div>
          ))}
        </div>
      </div>

      {/* Built for Enterprise */}
      <div className="flex flex-col border-[0.5px] border-[#eaecf0]/50 bg-white/5 px-8 py-8 backdrop-blur-[5px] md:h-[360px] md:pb-0">
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
  { icon: '/enterprise/icon-blocks.svg', title: 'Extensible', desc: 'MCP support, custom integrations, full API' },
  { icon: '/enterprise/icon-map-pin.svg', title: 'Data Sovereignty', desc: 'On-prem, sovereign cloud, or air-gapped' },
  { icon: '/enterprise/icon-ai-scan.svg', title: 'Automations', desc: 'Reusable workflows for recurring tasks' },
  { icon: '/enterprise/icon-earth.svg', title: 'European Delivery', desc: 'Trusted partners for sovereign deployments' },
  { icon: '/enterprise/icon-heart.svg', title: 'All Platforms', desc: 'Web, Windows, macOS, Linux, iOS, Android' },
  { icon: '/enterprise/icon-directions.svg', title: 'Model + Agent Agnostic', desc: 'Connect any ACP-compatible agent or OpenAI-compatible model' },
]

const CompromiseSection = () => (
  <section className="pt-12 md:pt-24">
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
      <div className="mt-6 grid grid-cols-2 gap-2 md:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="flex min-h-[144px] flex-col border border-[#d0d5dd]/50 bg-[#f9fafb]/30 p-4 shadow-[0px_7px_12px_0px_rgba(0,0,0,0.07)] backdrop-blur-[1px]">
            <img src={f.icon} alt="" className="size-6" />
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
  <section className="relative py-24">
    {/* Gray background block — left 63.6% of the page (916/1440) */}
    <div
      className="pointer-events-none absolute inset-y-[10%] left-0 hidden bg-[#eff1f4] lg:block"
      style={{ width: '63.6%' }}
      aria-hidden="true"
    />
    <div className="relative mx-auto flex max-w-[1120px] flex-col gap-8 px-6 md:flex-row md:items-start md:gap-[66px] lg:px-0">
      {/* Label — icon stacked above text */}
      <div className="flex shrink-0 flex-col items-start gap-3 md:w-[248px]">
        <img src="/enterprise/icon-factory-24.svg" alt="" className="size-6" />
        <p className="text-lg uppercase tracking-[-0.36px] text-[#667085]">
          Trusted by Organizations That Can&rsquo;t Compromise
        </p>
      </div>
      {/* Quote card group */}
      <div className="relative flex-1">
        <div className="absolute left-0 top-0 hidden size-3 bg-[#d0d5dd] lg:block" />
        <div className="border border-[#d0d5dd] bg-white p-10 shadow-[0px_48px_100px_0px_rgba(17,12,46,0.15)] md:ml-[6px] md:mt-[6px]">
          <p className="max-w-[768px] text-[32px] font-medium leading-[1.2] tracking-[-1.12px] text-[#101828] md:text-[56px]">
            &ldquo;Organizations across sectors are recognizing that AI is too important to outsource.&rdquo;
          </p>
          <p className="mt-6 text-xl font-bold leading-7 tracking-[-0.4px] text-[#667085]">
            Ryan Sipes,<br />CEO, Mozilla Thunderbird
          </p>
        </div>
      </div>
    </div>
  </section>
)

/* ─── CTA Section ─────────────────────────────────────── */

const CTASection = () => (
  <section className="py-24">
    <div className="mx-auto max-w-[737px] px-6 text-center">
      <img src="/enterprise/icon-zap-pixel.svg" alt="Thunderbolt" className="mx-auto size-6" />
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
  <footer className="relative z-10 bg-[#f9fafb] pb-16">
    <div className="mx-auto max-w-[1120px] px-6 lg:px-0">
      <div className="flex items-center justify-center gap-2">
        <img src="/enterprise/thunderbolt-logo.svg" alt="Thunderbolt" className="size-[34px]" />
        <span className="text-xl font-medium tracking-tight text-[#101828]">Thunderbolt</span>
      </div>
      <div className="mx-auto mt-6 h-px max-w-[1118px] bg-[#eaecf0]" />
      <div className="mt-6 flex flex-col items-center justify-center gap-4 text-center md:flex-row md:gap-[60px]">
        <img src="/enterprise/mozilla-logo.svg" alt="Mozilla" className="h-6 w-auto" />
        <p className="max-w-[638px] text-xs leading-4 text-[#667085]">
          Thunderbolt is part of{' '}
          <a href="https://blog.thunderbird.net/2020/01/thunderbirds-new-home/" className="border-b border-[#667085]/40" target="_blank" rel="noopener noreferrer">
            MZLA Technologies Corporation
          </a>
          , a wholly owned subsidiary of Mozilla Foundation. Portions of this content are &copy;1998&ndash;2026 by individual contributors. Content available under a{' '}
          <a href="https://www.mozilla.org/foundation/licensing/website-content/" className="border-b border-[#667085]/40" target="_blank" rel="noopener noreferrer">
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

import { FooterSection } from '../footer-section'
import { Header } from '../header'

/* ─── Shared ──────────────────────────────────────────── */

const GetStartedButton = () => (
  <a
    href="/contact"
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

/* ─── Prompt Card ─────────────────────────────────────── */

const PromptCard = ({ pillGapClass = 'gap-1.5 sm:gap-2' }: { pillGapClass?: string }) => (
  <>
    <div className="absolute -left-[12px] -top-[12px] size-[23px] bg-[#eaecf0]" />
    <div className="absolute -right-[12px] -top-[12px] size-[23px] bg-[#eaecf0]" />
    <div className="absolute -bottom-[12px] -left-[12px] size-[23px] bg-[#eaecf0]" />
    <div className="absolute -bottom-[12px] -right-[12px] size-[23px] bg-[#eaecf0]" />
    <div className="border-[0.5px] border-[#eaecf0] bg-gradient-to-b from-[rgba(241,241,241,0.3)] to-[rgba(228,228,228,0.3)] p-5 backdrop-blur-[5px]">
      <div className={`flex items-center ${pillGapClass}`}>
        {['Check the weather', 'Write a message', 'Check the schedule'].map((label) => (
          <span key={label} className="shrink-0 rounded-full bg-white px-2 py-1 text-[9px] sm:px-3.5 sm:py-1.5 sm:text-[11px] whitespace-nowrap text-[#344054] shadow-[0px_2px_8px_0px_rgba(0,0,0,0.08)]">
            {label}
          </span>
        ))}
        <span className="flex size-7 items-center justify-center rounded-full bg-white text-sm text-[#344054] shadow-[0px_2px_8px_0px_rgba(0,0,0,0.08)]">+</span>
      </div>
      <div className="mt-2.5 rounded-2xl bg-white px-4 pb-3 pt-3 shadow-[0px_2px_8px_0px_rgba(0,0,0,0.08)]">
        <p className="text-sm text-[#667085]">Ask me anything</p>
        <div className="mt-2 flex items-center justify-between">
          <span className="inline-flex size-7 items-center justify-center rounded-lg bg-[#f2f4f7] text-sm font-bold text-[#344054]">+</span>
          <span className="flex size-7 items-center justify-center rounded-lg bg-[#f2f4f7] text-sm font-bold text-[#344054]">&uarr;</span>
        </div>
      </div>
    </div>
  </>
)

/* ─── Hero ────────────────────────────────────────────── */

const Hero = () => (
  <section className="relative pb-16 pt-[80px]">
    <div className="mx-auto flex max-w-[730px] flex-col items-center gap-8 px-6 text-center">
      <h1 className="text-[40px] font-medium leading-[1.1] tracking-[-0.96px] text-[#101828] md:text-[48px]">
        AI You Control
      </h1>
      <p className="max-w-[718px] text-lg leading-[1.2] text-[#667085] md:text-2xl">
        The Open-Source, Cross-Platform, Extensible AI Client
      </p>
      <GetStartedButton />
    </div>
    {/* Device mockups — composed from separate SVG frames + PNG screenshots */}
    <div className="mx-auto mt-10 max-w-[1120px] px-6 lg:px-0">
      {/* Prompt input card — static on mobile, absolutely positioned on lg */}
      <div className="relative mb-6 lg:hidden">
        <PromptCard />
      </div>
      <div className="relative mx-auto max-w-[800px] lg:max-w-none" style={{ paddingBottom: '45.6%' }}>
        {/* MacBook frame + screenshot */}
        <div
          className="absolute left-[8%] lg:left-[24.2%] w-[85%] lg:w-[73.4%]"
          style={{ top: '10.9%', filter: 'drop-shadow(0px 50px 100px rgba(50, 50, 93, 0.25))' }}
        >
          <img src="/enterprise/desktop_device.svg" alt="" className="relative w-full" fetchPriority="high" />
          <img
            src="/enterprise/desktop_screenshot.png"
            alt="Thunderbolt desktop app"
            className="absolute z-10"
            style={{ top: '5.7%', left: '12.7%', width: '74.5%', height: '83%', objectFit: 'cover' }}
            fetchPriority="high"
          />
        </div>
        {/* iPhone frame + screenshot */}
        <div
          className="absolute z-20 left-[62%] lg:left-[77%] w-[28%] lg:w-[23%]"
          style={{ top: '0%', filter: 'drop-shadow(0px 50px 100px rgba(50, 50, 93, 0.25))' }}
        >
          <img src="/enterprise/mobile_device.svg" alt="" className="relative w-full" fetchPriority="high" />
          <img
            src="/enterprise/mobile_screenshot.png"
            alt="Thunderbolt mobile app"
            className="absolute z-10"
            style={{ top: '4.1%', left: '8%', width: '83.5%', height: '91%', objectFit: 'cover', borderRadius: '6%' }}
            fetchPriority="high"
          />
        </div>
        {/* Prompt input card overlay — desktop only */}
        <div className="absolute z-30 hidden lg:block" style={{ left: '0%', top: '26.8%', width: '66.8%' }}>
          <PromptCard pillGapClass="flex-wrap gap-2" />
        </div>
      </div>
    </div>
  </section>
)

/* ─── Feature Cards ───────────────────────────────────── */

const FeatureCards = () => (
  <section className="relative">
    <div className="mx-auto mt-12 grid max-w-[1120px] gap-0 px-6 md:grid-cols-3 lg:mt-16 lg:items-start lg:px-0">
      {/* Control Your Data */}
      <div className="relative flex flex-col justify-end overflow-visible border-[0.5px] border-[#eaecf0]/50 bg-white/5 px-8 pb-8 backdrop-blur-[7px] md:h-[360px]">
        <div className="pointer-events-none absolute -left-[6px] -top-[6px] z-10 hidden size-3 bg-[#eaecf0] lg:block" />
        <div className="pointer-events-none absolute -right-[6px] -top-[6px] z-10 hidden size-3 bg-[#eaecf0] lg:block" />
        <div className="pointer-events-none absolute -bottom-[6px] -left-[6px] z-10 hidden size-3 bg-[#eaecf0] lg:block" />
        <div className="pointer-events-none absolute -bottom-[6px] -right-[6px] z-10 hidden size-3 bg-[#eaecf0] lg:block" />
        <div className="relative mb-4 h-[180px] w-[181px]">
          <div className="absolute left-[40px] top-[20px] h-[185px] w-[134px] rounded-[67px] bg-[#98a2b3] opacity-70 blur-[25px]" />
          <img src="/enterprise/control-data.png" alt="" className="relative size-full object-contain object-bottom" />
        </div>
        <h3 className="text-2xl font-medium leading-8 tracking-[-0.48px] text-[#101828]">Control Your Data</h3>
        <p className="mt-2 text-base leading-6 text-[#667085]">
          Self-host on your infrastructure or let us help you deploy. Your data never leaves your control.
        </p>
      </div>

      {/* Choose Any Agent (or Model) — sits higher than adjacent cards per Figma */}
      <div className="relative flex flex-col overflow-hidden border-[0.5px] border-[#eaecf0]/50 bg-white/5 px-8 pt-8 pb-2 backdrop-blur-sm md:overflow-visible lg:-mt-[71px]">
        <div className="pointer-events-none absolute -left-[6px] -top-[6px] z-10 hidden size-3 bg-[#eaecf0] lg:block" />
        <div className="pointer-events-none absolute -right-[6px] -top-[6px] z-10 hidden size-3 bg-[#eaecf0] lg:block" />
        <div className="pointer-events-none absolute -bottom-[6px] -left-[6px] z-10 hidden size-3 bg-[#eaecf0] lg:block" />
        <div className="pointer-events-none absolute -bottom-[6px] -right-[6px] z-10 hidden size-3 bg-[#eaecf0] lg:block" />
        <h3 className="text-2xl font-medium leading-8 tracking-[-0.48px] text-[#101828]">
          Choose Any Agent<br />(or Model)
        </h3>
        <p className="mt-2 text-base leading-6 text-[#667085]">
          Connect any ACP-compatible agent or any model with an OpenAI-compatible API (Claude, Codex, OpenClaw, DeepSeek, OpenCode).
        </p>
        {/* Model logos — wave layout, scaled down on md to fit the 2-col grid */}
        <div className="relative z-10 mx-auto mt-4 h-[173px] w-[402px] origin-top-left md:-ml-[68px] md:mx-0 md:scale-75 lg:-ml-[55px] lg:scale-100">
          {[
            { src: '/enterprise/chatgpt.png', alt: 'ChatGPT', size: 38, x: 0, y: 23, z: 3 },
            { src: '/enterprise/anthropic.png', alt: 'Anthropic', size: 48, x: 80, y: 88, z: 6 },
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
      <div className="relative z-0 flex flex-col border-[0.5px] border-[#eaecf0]/50 bg-[#f9fafb] px-8 py-8 md:h-[360px] md:pb-0">
        <div className="pointer-events-none absolute -left-[6px] -top-[6px] z-10 hidden size-3 bg-[#eaecf0] lg:block" />
        <div className="pointer-events-none absolute -right-[6px] -top-[6px] z-10 hidden size-3 bg-[#eaecf0] lg:block" />
        <div className="pointer-events-none absolute -bottom-[6px] -left-[6px] z-10 hidden size-3 bg-[#eaecf0] lg:block" />
        <div className="pointer-events-none absolute -bottom-[6px] -right-[6px] z-10 hidden size-3 bg-[#eaecf0] lg:block" />
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
            Open Source &bull; Self-Hosted &bull; Enterprise-Ready
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
  <section className="relative overflow-hidden py-24">
    {/* Gray background block — left 63.6% of the page (916/1440) */}
    <div
      className="pointer-events-none absolute inset-y-[10%] left-0 hidden bg-[#eff1f4] lg:block"
      style={{ width: '63.6%' }}
      aria-hidden="true"
    />
    <div className="relative flex flex-col gap-8 pl-6 md:flex-row md:items-start md:gap-[66px]">
      {/* Label — icon stacked above text, aligned to the 1120px content grid */}
      <div className="flex shrink-0 flex-col items-start gap-3 pr-6 md:pr-0 md:w-[248px] lg:ml-[calc((100vw-1120px)/2)]">
        <img src="/enterprise/icon-factory-24.svg" alt="" className="size-6" />
        <p className="text-lg uppercase tracking-[-0.36px] text-[#667085]">
          Trusted by Organizations That Won&rsquo;t Compromise
        </p>
      </div>
      {/* Quote card group — stretches to right edge of screen */}
      <div className="relative flex-1">
        <div className="absolute left-0 top-0 hidden size-3 bg-[#d0d5dd] lg:block" />
        <div className="absolute -bottom-[6px] left-0 hidden size-3 bg-[#d0d5dd] lg:block" />
        <div className="border border-[#d0d5dd] border-r-0 bg-white p-10 shadow-[0px_48px_100px_0px_rgba(17,12,46,0.15)] md:ml-[6px] md:mt-[6px]">
          <p className="max-w-[768px] text-[32px] font-medium leading-[1.2] tracking-[-1.12px] text-[#101828] md:text-[56px]">
            &ldquo;Organizations are recognizing that AI is too important to outsource.&rdquo;
          </p>
          <p className="mt-6 font-['Mozilla_Text',sans-serif] text-[19px] font-normal uppercase leading-[26px] tracking-[-0.38px] text-[#344054]">
            <span className="hidden md:inline">Ryan Sipes, CEO, Mozilla Thunderbird</span>
            <span className="md:hidden">Ryan Sipes,<br />CEO, Mozilla Thunderbird</span>
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

/* ─── Mobile Sticky Footer CTA ───────────────────────── */

const MobileFooterCTA = () => (
  <div className="fixed inset-x-0 bottom-0 z-50 bg-white/20 backdrop-blur-[32px] px-6 py-4 md:hidden">
    <a
      href="/contact"
      className="flex h-[46px] w-full items-center justify-center bg-[#344054] font-mono text-sm font-bold uppercase tracking-wider text-white transition-colors hover:bg-[#344054]/90"
    >
      Get Started
    </a>
  </div>
)

/* ─── Page ────────────────────────────────────────────── */

export const EnterprisePage = () => (
  <div className="relative min-h-screen overflow-x-hidden bg-[#f9fafb]">
    <BackgroundGrid />
    <Header
      action={
        <div className="flex items-center gap-6">
          <a href="https://github.com/thunderbird/thunderbolt" target="_blank" rel="noopener noreferrer" className="flex items-center">
            <img src="/enterprise/github.svg" alt="GitHub" className="h-7 w-auto" />
          </a>
          <GetStartedButton />
        </div>
      }
    />
    <main className="relative pt-[104px]">
      <Hero />
      <FeatureCards />
      <CompromiseSection />
      <QuoteSection />
      <CTASection />
    </main>
    <FooterSection className="relative z-10 bg-[#f9fafb] pb-24 md:pb-16" />
    <MobileFooterCTA />
  </div>
)

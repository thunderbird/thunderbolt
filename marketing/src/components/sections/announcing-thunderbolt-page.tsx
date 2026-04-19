import { useState } from 'react'
import { FooterSection } from '../footer-section'
import { Header } from '../header'

/* ─── Constants ──────────────────────────────────────── */

const PUBLISH_DATE = 'Apr 16, 2026'
const READ_TIME = '9 min read'
const AUTHOR = {
  name: 'Thunderbolt Team',
  role: 'MZLA Technologies',
  avatar: '/enterprise/thunderbolt-logo.png',
}

/* ─── Background Grid (reused from enterprise page) ─── */

const BackgroundGrid = () => (
  <div className="pointer-events-none absolute inset-0 z-0 hidden overflow-hidden lg:block" aria-hidden="true">
    <div className="absolute inset-y-0 left-1/2 w-[1120px] -translate-x-1/2">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div key={i} className="absolute inset-y-0 w-px bg-[#eaecf0]/60" style={{ left: i * 160 }} />
      ))}
    </div>
  </div>
)

/* ─── Copy URL Button ────────────────────────────────── */

const CopyUrlButton = () => {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-[#667085] transition-colors hover:text-[#101828]"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M6.667 8.667a3.333 3.333 0 0 0 5.026.36l2-2a3.334 3.334 0 0 0-4.713-4.714l-1.147 1.14"
          stroke="currentColor"
          strokeWidth="1.33"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M9.333 7.333a3.334 3.334 0 0 0-5.026-.36l-2 2a3.333 3.333 0 0 0 4.713 4.714l1.14-1.14"
          stroke="currentColor"
          strokeWidth="1.33"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {copied ? 'Copied!' : 'Copy URL'}
    </button>
  )
}

/* ─── Article Content ────────────────────────────────── */

const ArticleImage = ({ src, alt }: { src: string; alt: string }) => (
  <div className="my-8">
    <img src={src} alt={alt} className="w-full rounded-lg" />
  </div>
)

const ArticleContent = () => (
  <div className="prose-thunderbolt">
    <h2 className="!mt-0 !text-xl !tracking-[-0.2px] !text-[#344054] !font-medium !leading-[1.5]">
      Open-source and self-hostable, Thunderbolt gives organizations autonomy over how AI is built and
      run, with integrated infrastructure powered by deepset&rsquo;s Haystack
    </h2>

    <p>
      MZLA Technologies Corporation, a subsidiary of the Mozilla Foundation, today announced
      Thunderbolt, an open-source AI client that gives organizations what proprietary AI services
      can&rsquo;t: full ownership of their data, freedom from vendor dependencies, and AI
      infrastructure that stays entirely within their hands &ndash; self-hostable, customizable, and
      built on open standards.
    </p>

    <p>
      Organizations need solutions that provide flexibility and capability without sacrificing control,
      transparency, or long-term independence. Through a native integration with deepset&rsquo;s
      Haystack, Thunderbolt extends control to the infrastructure layer &ndash; connecting the client
      experience with enterprise-grade agents and RAG orchestration within a unified architecture.
    </p>

    <blockquote>
      &ldquo;AI is too important to outsource. With Thunderbolt, we&rsquo;re giving organizations a
      sovereign AI client that allows them to decide how AI fits into their workflows &ndash; on their
      infrastructure, with their data, and on their terms.&rdquo;
      <cite>Ryan Sipes, CEO of MZLA Technologies Corporation</cite>
    </blockquote>

    <ArticleImage src="/enterprise/ui.png" alt="Thunderbolt AI client interface" />

    <h2>An Open, Extensible AI Workspace</h2>

    <p>
      Thunderbolt is designed as a sovereign AI client &ndash; an open-source, extensible workspace
      where users can interact with AI through chat, search, and research, connect to enterprise data,
      and choose the models and tools that fit their needs.
    </p>

    <p>It allows organizations to:</p>

    <ul>
      <li>
        <strong>Run AI with their choice of models</strong>, from leading commercial providers to
        open-source and local models
      </li>
      <li>
        <strong>Connect to systems and data:</strong> Integrate with pipelines and open protocols,
        including deepset&rsquo;s Haystack platform, Model Context Protocol (MCP) servers, and agents
        with the Agent Client Protocol (ACP)
      </li>
      <li>
        <strong>Automate workflows and recurring tasks:</strong> Generate daily briefings, monitor
        topics, compile reports, or trigger actions based on events and schedules
      </li>
      <li>
        <strong>Work seamlessly across devices</strong> with native applications for Windows, macOS,
        Linux, iOS, and Android
      </li>
      <li>
        <strong>Maintain security</strong> with self-hosted deployment, optional end-to-end encryption,
        and device-level access controls
      </li>
    </ul>

    <p>
      By combining flexibility, extensibility, and control, Thunderbolt transforms AI from a standalone
      tool into a customizable system that adapts to each organization&rsquo;s specific needs and
      workflows.
    </p>

    <ArticleImage src="/enterprise/architecture.png" alt="Thunderbolt and Haystack architecture" />

    <h2>
      From Infrastructure to Interface: A Complete Sovereign AI Stack &amp; Delivery Model with
      deepset&rsquo;s Haystack
    </h2>

    <p>
      Organizations increasingly recognize that sovereignty can&rsquo;t stop at the interface. It must
      extend across the entire stack, from how systems are built and governed to how they are used every
      day.
    </p>

    <p>
      To support this, MZLA Technologies Corporation is partnering with deepset, a Berlin-based AI
      infrastructure company behind the popular open-source Haystack agent framework. Together,
      Thunderbolt and Haystack connect the user-facing AI experience with agent and RAG backend
      orchestration, enabling organizations to operate AI systems within a unified architecture.
    </p>

    <p>
      deepset works with enterprise and public sector organizations &ndash; including government
      agencies, aerospace manufacturers, and multinational organizations &ndash; embedding
      forward-deployed engineering teams directly within client environments to support architecture,
      implementation, and ongoing operations.
    </p>

    <p>Together, the platforms connect two critical layers &ndash; how AI is experienced and how it is built:</p>

    <ul>
      <li>
        <strong>AI Client Experience (Thunderbolt):</strong> A sovereign AI client that enables chat,
        search, research, automation, and cross-device workflows through a self-hostable, extensible
        interface
      </li>
      <li>
        <strong>AI Infrastructure &amp; Orchestration (deepset / Haystack):</strong> The foundation
        where AI systems are built, deployed, and governed &ndash; enabling agents, RAG applications,
        and data-driven systems across cloud or fully self-hosted environments
      </li>
    </ul>

    <p>
      This integrated approach moves organizations beyond fragmented AI tools toward operational AI
      systems, where the user experience and underlying infrastructure are tightly connected and AI
      becomes a governed, reliable part of daily operations rather than isolated capabilities.
    </p>

    <blockquote>
      &ldquo;Integrating with Haystack is a natural opportunity to extend Thunderbolt&rsquo;s
      sovereignty to the infrastructure beneath. This gives organizations control not just over how they
      interact with AI, but how it is built and run.&rdquo;
      <cite>Ryan Sipes, CEO of MZLA Technologies Corporation</cite>
    </blockquote>

    <blockquote>
      &ldquo;Organizations are looking for a complete sovereign AI stack, paired with the expertise to
      deliver it. Together, Haystack and Thunderbolt bring both &ndash; enabling teams to move from
      concept to production with full control.&rdquo;
      <cite>Milos Rusic, CEO and co-founder of deepset</cite>
    </blockquote>

    <h2>Availability</h2>

    <p>
      Thunderbolt is available now via waitlist at{' '}
      <a href="https://thunderbolt.io">thunderbolt.io</a> with native applications for web, macOS,
      Windows, Linux, iOS, and Android. The Thunderbolt{' '}
      <a href="https://github.com/thunderbird/thunderbolt" target="_blank" rel="noopener noreferrer">
        source code
      </a>{' '}
      is available on GitHub.
    </p>

    <p>
      For enterprise deployments, Thunderbolt pricing reflects support level, customization
      requirements, and deployment complexity. Integration partners can package Thunderbolt with
      sovereign storage, infrastructure management, and Forward-Deployed Engineering support as part of
      comprehensive sovereign AI solutions.
    </p>

    <p>
      Organizations interested in pilot deployments or enterprise licensing should contact{' '}
      <a href="mailto:enterprise@thunderbolt.io">enterprise@thunderbolt.io</a>.
    </p>

    <h2>About MZLA Technologies Corporation</h2>

    <p>
      MZLA Technologies Corporation is a wholly owned subsidiary of the Mozilla Foundation and the
      organization behind Thunderbird, one of the world&rsquo;s most widely used open-source email
      clients with over 20 million active users. Guided by principles of openness, user control, and
      privacy, MZLA develops software that gives individuals and organizations ownership over their
      digital infrastructure. Thunderbolt is funded through a dedicated investment from Mozilla and is
      being developed by a separate team focused on enterprise AI products, distinct from
      Thunderbird&rsquo;s donation-supported consumer product work.
    </p>

    <h2>About Mozilla</h2>

    <p>
      Mozilla is a non-profit organization whose mission is to ensure the internet is a global public
      resource, open and accessible to all. Mozilla creates and maintains Firefox, one of the
      world&rsquo;s leading web browsers, and invests in products and initiatives that advance openness,
      privacy, and individual empowerment online. Learn more at{' '}
      <a href="https://mozilla.org" target="_blank" rel="noopener noreferrer">
        mozilla.org
      </a>
      .
    </p>
  </div>
)

/* ─── Page ───────────────────────────────────────────── */

export const AnnouncingThunderboltPage = () => (
  <div className="relative min-h-screen overflow-x-hidden bg-[#f9fafb]">
    <BackgroundGrid />
    <Header
      action={
        <a
          href="https://github.com/thunderbird/thunderbolt"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-[46px] items-center justify-center gap-2 bg-[#344054] px-5 font-mono text-sm font-bold uppercase tracking-wider text-white transition-colors hover:bg-[#344054]/90"
        >
          <img src="/enterprise/github.svg" alt="" className="size-[18px] invert" />
          Get Started
        </a>
      }
    />

    <main className="relative z-10 pt-[104px]">
      {/* ─── Hero / Title Block ─── */}
      <section className="pb-8 pt-16 md:pt-24">
        <div className="mx-auto max-w-[800px] px-6">
          <a href="/" className="mb-6 inline-flex items-center gap-1 text-sm text-[#667085] hover:text-[#344054]">
            &larr; Back
          </a>
          {/* Decorative frame — Vercel-style with Thunderbolt's corner squares */}
          <div className="relative border-[0.5px] border-[#eaecf0] px-6 pb-12 pt-10 md:px-12">
            {/* Corner squares */}
            <div className="absolute -left-[6px] -top-[6px] size-3 bg-[#eaecf0]" />
            <div className="absolute -right-[6px] -top-[6px] size-3 bg-[#eaecf0]" />
            <div className="absolute -bottom-[6px] -left-[6px] size-3 bg-[#eaecf0]" />
            <div className="absolute -bottom-[6px] -right-[6px] size-3 bg-[#eaecf0]" />

            {/* Center vertical line */}
            <div className="absolute inset-y-0 left-1/2 w-px bg-[#eaecf0]/40" />

            {/* Title */}
            <h1 className="text-center text-[32px] font-medium leading-[1.1] tracking-[-0.96px] text-[#101828] md:text-[44px]">
              Mozilla Introduces Thunderbolt: An Enterprise AI Client Built for Control and Independence
            </h1>

            {/* Author */}
            <div className="mt-8 flex items-center justify-center gap-3">
              <img
                src={AUTHOR.avatar}
                alt={AUTHOR.name}
                className="size-8 rounded-full"
              />
              <div className="flex items-center gap-1.5 text-sm">
                <span className="font-medium text-[#101828]">{AUTHOR.name}</span>
                <span className="text-[#667085]">{AUTHOR.role}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Meta Bar ─── */}
      <div className="mx-auto max-w-[800px] px-6 md:px-[72px]">
        <div className="flex items-center justify-between border-b border-[#eaecf0] pb-6">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 text-sm text-[#667085]">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
                <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {READ_TIME}
            </span>
            <CopyUrlButton />
          </div>
          <span className="text-sm text-[#667085]">{PUBLISH_DATE}</span>
        </div>
      </div>

      {/* ─── Article Body ─── */}
      <article className="mx-auto max-w-[800px] px-6 pb-24 pt-10 md:px-[72px]">
        <ArticleContent />
      </article>
    </main>

    <FooterSection className="relative z-10 bg-[#f9fafb] pb-16" />
  </div>
)

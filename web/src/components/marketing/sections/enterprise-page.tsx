/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import { FooterSection } from '../footer-section'
import { Header } from '../header'

/* ─── Shared ──────────────────────────────────────────── */

const GitHubIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" width="18" height="18" style={{ flexShrink: 0 }}>
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
  </svg>
)

const REPO_URL = 'https://github.com/thunderbird/thunderbolt'

const StarIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flexShrink: 0 }}
  >
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
)

// Primary CTA: dark-blue button — GitHub icon + "Star on GitHub" label.
const StarOnGitHubButton = ({ fullWidth = false }: { fullWidth?: boolean }) => (
  <a
    href={REPO_URL}
    target="_blank"
    rel="noopener noreferrer"
    className={`${fullWidth ? 'flex w-full' : 'inline-flex'} h-[46px] items-center justify-center gap-2 bg-[#344054] px-5 font-mono text-sm font-bold uppercase tracking-wider text-white transition-colors hover:bg-[#344054]/90`}
  >
    <GitHubIcon />
    Star on GitHub
  </a>
)

const formatStars = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n)

// Compact header badge: GitHub icon + live star count, desktop only.
// Geometry is reserved from first paint to prevent layout shift while the
// fetch is in flight; the badge fades in once the count resolves. If the
// fetch fails, the badge unmounts so it doesn't leave a permanent gap.
const StarCountBadge = () => {
  const [stars, setStars] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('https://api.github.com/repos/thunderbird/thunderbolt')
        if (!res.ok) throw new Error(`GitHub API responded ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        if (typeof data.stargazers_count !== 'number') throw new Error('Missing stargazers_count')
        setStars(data.stargazers_count)
      } catch {
        if (!cancelled) setFailed(true)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  if (failed) return null

  const loaded = stars !== null

  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={stars !== null ? `${stars} stars on GitHub` : undefined}
      aria-hidden={!loaded}
      tabIndex={loaded ? undefined : -1}
      className={`hidden h-[46px] min-w-[112px] items-center justify-center gap-2 border border-[#344054] px-4 text-sm font-medium text-[#344054] transition-opacity duration-200 hover:bg-[#f2f4f7] md:inline-flex ${loaded ? 'opacity-100' : 'opacity-0'}`}
    >
      <GitHubIcon />
      <StarIcon />
      <span>{stars !== null ? formatStars(stars) : ''}</span>
    </a>
  )
}

const EnterpriseInquiriesButton = () => (
  <a
    href="/contact"
    className="group inline-flex h-[46px] items-center justify-center gap-2 border border-[#344054] px-5 font-mono text-sm font-bold uppercase tracking-wider text-[#344054] transition-colors hover:bg-[#344054] hover:text-white"
  >
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
    Get in Touch
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
        {['Conduct research', 'Organize my files', 'Search my email'].map((label) => (
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

/* ─── Desktop Mockup (inline SVG with clipped screenshot) */

const DesktopMockup = () => (
  <svg viewBox="0 0 726 350" fill="none" xmlns="http://www.w3.org/2000/svg" className="relative w-full">
    <defs>
      <clipPath id="desktop-screen-clip">
        <rect x="89.207" y="19.834" width="547.279" height="290.599" />
      </clipPath>
      <filter id="filter0_i" x="0.675171" y="331.449" width="724.651" height="3.94098" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
        <feOffset dy="1.53255" />
        <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
        <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.02 0" />
        <feBlend mode="normal" in2="shape" result="effect1_innerShadow" />
      </filter>
      <filter id="filter1_i" x="293.499" y="331.446" width="138.655" height="5.25488" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
        <feOffset dy="1.53255" />
        <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
        <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.03 0" />
        <feBlend mode="normal" in2="shape" result="effect1_innerShadow" />
      </filter>
      <linearGradient id="paint0" x1="0.337891" y1="335.718" x2="725.663" y2="335.718" gradientUnits="userSpaceOnUse">
        <stop stopOpacity="0.04" />
        <stop offset="1" stopColor="white" stopOpacity="0.04" />
      </linearGradient>
      <linearGradient id="paint1" x1="732.498" y1="330.551" x2="697.996" y2="330.551" gradientUnits="userSpaceOnUse">
        <stop />
        <stop offset="1" stopColor="white" />
        <stop offset="1" stopColor="white" />
      </linearGradient>
      <linearGradient id="paint2" x1="0.337891" y1="335.718" x2="28.0015" y2="335.718" gradientUnits="userSpaceOnUse">
        <stop />
        <stop offset="1" stopColor="white" />
        <stop offset="1" stopColor="white" />
      </linearGradient>
      <linearGradient id="paint3" x1="0" y1="349.181" x2="726" y2="349.181" gradientUnits="userSpaceOnUse">
        <stop stopOpacity="0.07" />
        <stop offset="1" stopColor="#EAEAEA" stopOpacity="0.07" />
        <stop offset="1" stopColor="white" stopOpacity="0.07" />
      </linearGradient>
      <linearGradient id="paint4" x1="0" y1="349.181" x2="726" y2="349.181" gradientUnits="userSpaceOnUse">
        <stop stopOpacity="0.07" />
        <stop offset="1" stopColor="#EAEAEA" stopOpacity="0.07" />
        <stop offset="1" stopColor="white" stopOpacity="0.07" />
      </linearGradient>
      <linearGradient id="paint5" x1="0" y1="334.731" x2="0" y2="349.181" gradientUnits="userSpaceOnUse">
        <stop stopOpacity="0.07" />
        <stop offset="1" stopColor="white" stopOpacity="0.07" />
      </linearGradient>
      <linearGradient id="paint6" x1="0" y1="334.731" x2="0" y2="349.181" gradientUnits="userSpaceOnUse">
        <stop stopColor="white" stopOpacity="0.05" />
        <stop offset="1" stopOpacity="0.05" />
      </linearGradient>
      <linearGradient id="paint7" x1="363" y1="334.731" x2="363.255" y2="358.473" gradientUnits="userSpaceOnUse">
        <stop stopColor="#EBEBEB" />
        <stop offset="1" stopColor="#585858" stopOpacity="0" />
      </linearGradient>
      <linearGradient id="paint8" x1="292.824" y1="337.029" x2="307.331" y2="337.029" gradientUnits="userSpaceOnUse">
        <stop />
        <stop offset="1" stopColor="white" />
        <stop offset="1" stopColor="white" />
      </linearGradient>
      <linearGradient id="paint9" x1="432.493" y1="330.789" x2="418.324" y2="330.789" gradientUnits="userSpaceOnUse">
        <stop />
        <stop offset="1" stopColor="white" />
        <stop offset="1" stopColor="white" />
      </linearGradient>
    </defs>
    {/* Outer body */}
    <path d="M637.696 0.25C644.31 0.250036 649.459 1.4171 652.955 4.39355C656.46 7.37802 658.25 12.1353 658.25 19.1865V320.49C658.25 328.619 656.012 332.973 652.484 335.269C648.985 337.546 644.279 337.75 639.476 337.75H105.32C96.0761 337.75 86.932 337.755 80.1064 334.552C76.6823 332.945 73.8366 330.53 71.8506 326.907C69.8668 323.289 68.75 318.482 68.75 312.106V14.1572C68.75 8.94251 70.5545 5.45501 73.0625 3.27539C75.5633 1.10229 78.7392 0.250006 81.4551 0.25H637.696Z" fill="#F9FAFB" stroke="#EFF1F4" strokeWidth="0.5" />
    {/* Camera dot */}
    <path fillRule="evenodd" clipRule="evenodd" d="M361.819 37.9134C363.03 37.9134 364.012 38.8691 364.012 40.0481C364.012 41.227 363.03 42.1828 361.819 42.1828C360.608 42.1828 359.627 41.227 359.627 40.0481C359.627 38.8691 360.608 37.9134 361.819 37.9134Z" fill="#F2F2F2" />
    {/* White screen background */}
    <rect x="89.207" y="19.834" width="547.279" height="290.599" fill="#FFFFFF" />
    {/* Screenshot clipped to screen */}
    <image
      href="/enterprise/desktop_screenshot.png"
      x="89.207" y="19.834" width="547.279" height="290.599"
      preserveAspectRatio="xMidYMin slice"
      clipPath="url(#desktop-screen-clip)"
    />
    {/* Screen border */}
    <path d="M636.986 19.3337V310.933H88.707V19.3337H636.986Z" stroke="#E1E1E1" fill="none" />
    {/* Hinge bar */}
    <g filter="url(#filter0_i)">
      <path fillRule="evenodd" clipRule="evenodd" d="M0.675167 331.449H725.326V335.39H0.675167V331.449Z" fill="white" />
      <path fillRule="evenodd" clipRule="evenodd" d="M0.675167 331.449H725.326V335.39H0.675167V331.449Z" fill="url(#paint0)" style={{ mixBlendMode: 'multiply' }} />
    </g>
    <g opacity="0.1" style={{ mixBlendMode: 'multiply' }}>
      <path fillRule="evenodd" clipRule="evenodd" d="M698.333 331.448H725.322V335.389H698.333V331.448Z" fill="url(#paint1)" />
    </g>
    <g opacity="0.1" style={{ mixBlendMode: 'multiply' }}>
      <path fillRule="evenodd" clipRule="evenodd" d="M0.675248 331.449H27.6641V335.39H0.675248V331.449Z" fill="url(#paint2)" />
    </g>
    {/* Base */}
    <path fillRule="evenodd" clipRule="evenodd" d="M0.674454 335.388H725.326C721.043 337.991 683.056 348.672 556.645 345.897C545.481 345.897 230.866 345.569 161.933 345.569C81.9298 345.569 48.8112 345.882 18.5834 340.211C8.00125 338.226 2.70217 336.587 0.674454 335.388Z" fill="white" />
    <path fillRule="evenodd" clipRule="evenodd" d="M0.674454 335.388H725.326C721.043 337.991 683.056 348.672 556.645 345.897C545.481 345.897 230.866 345.569 161.933 345.569C81.9298 345.569 48.8112 345.882 18.5834 340.211C8.00125 338.226 2.70217 336.587 0.674454 335.388Z" fill="url(#paint3)" style={{ mixBlendMode: 'multiply' }} />
    <path fillRule="evenodd" clipRule="evenodd" d="M0.674454 335.388H725.326C721.043 337.991 683.056 348.672 556.645 345.897C545.481 345.897 230.866 345.569 161.933 345.569C81.9298 345.569 48.8112 345.882 18.5834 340.211C8.00125 338.226 2.70217 336.587 0.674454 335.388Z" fill="url(#paint4)" style={{ mixBlendMode: 'multiply' }} />
    <path fillRule="evenodd" clipRule="evenodd" d="M0.674454 335.388H725.326C721.043 337.991 683.056 348.672 556.645 345.897C545.481 345.897 230.866 345.569 161.933 345.569C81.9298 345.569 48.8112 345.882 18.5834 340.211C8.00125 338.226 2.70217 336.587 0.674454 335.388Z" fill="url(#paint5)" style={{ mixBlendMode: 'multiply' }} />
    <path fillRule="evenodd" clipRule="evenodd" d="M0.674454 335.388H725.326C721.043 337.991 683.056 348.672 556.645 345.897C545.481 345.897 230.866 345.569 161.933 345.569C81.9298 345.569 48.8112 345.882 18.5834 340.211C8.00125 338.226 2.70217 336.587 0.674454 335.388Z" fill="url(#paint6)" style={{ mixBlendMode: 'multiply' }} />
    <path fillRule="evenodd" clipRule="evenodd" d="M0.674454 335.388H725.326C721.043 337.991 683.056 348.672 556.645 345.897C545.481 345.897 230.866 345.569 161.933 345.569C81.9298 345.569 48.8112 345.882 18.5834 340.211C8.00125 338.226 2.70217 336.587 0.674454 335.388Z" fill="url(#paint7)" />
    {/* Trackpad notch */}
    <g filter="url(#filter1_i)">
      <path d="M432.154 331.446C432.154 331.446 432.154 333.674 432.154 335.059C432.154 336.439 418.734 336.7 418.66 336.701H306.993C306.94 336.7 293.499 336.44 293.499 335.059V331.446H432.154Z" fill="white" />
    </g>
    <g opacity="0.07" style={{ mixBlendMode: 'multiply' }}>
      <path fillRule="evenodd" clipRule="evenodd" d="M293.499 331.446H306.993V336.701C306.993 336.701 293.499 336.443 293.499 335.059C293.499 333.674 293.499 331.446 293.499 331.446Z" fill="url(#paint8)" />
    </g>
    <g opacity="0.07" style={{ mixBlendMode: 'multiply' }}>
      <path fillRule="evenodd" clipRule="evenodd" d="M432.156 331.446H418.662V336.701C418.662 336.701 432.156 336.443 432.156 335.059C432.156 333.674 432.156 331.446 432.156 331.446Z" fill="url(#paint9)" />
    </g>
  </svg>
)

/* ─── Hero ────────────────────────────────────────────── */

const Hero = () => (
  <section className="relative pb-16 pt-[80px]">
    <div className="mx-auto flex max-w-[730px] flex-col items-center gap-6 px-6 text-center">
      <h1 className="text-[40px] font-medium leading-[1.1] tracking-[-0.96px] text-[#101828] md:text-[48px]">
        AI You Control
      </h1>
      <p className="max-w-[718px] text-lg leading-[1.2] text-[#667085] md:text-2xl">
        The Open-Source, Cross-Platform, Extensible AI Client
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <StarOnGitHubButton />
        <EnterpriseInquiriesButton />
      </div>
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
          <DesktopMockup />
        </div>
        {/* iPhone frame + screenshot */}
        <div
          className="absolute z-20 left-[62%] lg:left-[77%] w-[28%] lg:w-[23%]"
          style={{ top: '0%', filter: 'drop-shadow(0px 50px 100px rgba(50, 50, 93, 0.25))' }}
        >
          <svg viewBox="0 0 228 452" fill="none" xmlns="http://www.w3.org/2000/svg" className="relative w-full">
            <defs>
              <clipPath id="mobile-screen-clip">
                <path d="M169.388 18.4507C176.045 18.4363 182.728 18.3336 189.4 18.4878C198.419 18.6976 205.801 24.5205 208.337 33.1489V33.1499C208.813 34.7742 209.052 36.4585 209.047 38.1509C209.039 51.5419 209.04 64.9321 209.049 78.3208C209.049 188.645 209.053 298.972 209.061 409.302C209.061 412.09 208.921 414.915 207.832 417.631C204.94 424.84 199.641 429.156 191.989 430.542L191.99 430.542C190.627 430.793 189.254 430.792 187.938 430.792H42.998C41.2406 430.792 39.4564 430.816 37.6797 430.755V430.754C28.1294 430.451 20.2682 423.728 18.4424 414.405L18.3594 413.958C18.1164 412.553 18.0947 411.156 18.0947 409.795C18.0911 368.299 18.0898 326.806 18.0918 285.317V224.723C18.0915 224.717 18.0898 224.71 18.0898 224.704C18.0898 167.937 18.0902 111.171 18.0918 54.4048C18.0918 48.8426 18.0148 43.2535 18.1523 37.6763C18.3741 28.7266 25.1034 20.8076 33.8535 18.9478L34.4424 18.8296C35.8189 18.5719 37.2168 18.4414 38.6182 18.4399C44.8435 18.4411 51.0683 18.4395 57.292 18.4351V18.436C58.2061 18.4337 59.1562 18.5775 59.917 19.3237L60.0664 19.481C60.6439 20.1332 60.8386 20.9001 60.8535 21.686C60.8802 23.0185 60.9055 24.2972 61.1797 25.5356C62.2175 30.22 66.2449 33.5613 71.0557 33.5991C78.7224 33.6604 86.3894 33.6204 94.0635 33.6216C114.304 33.6228 134.545 33.6228 154.786 33.6216C155.84 33.6216 156.827 33.6263 157.802 33.4224H157.804C162.44 32.4787 165.843 28.5158 166.068 23.8003V23.7983C166.088 23.4267 166.096 23.0541 166.105 22.6694C166.115 22.2881 166.127 21.8967 166.155 21.5044C166.221 20.6031 166.534 19.8294 167.108 19.2798C167.684 18.7284 168.471 18.4527 169.388 18.4507Z" />
              </clipPath>
            </defs>
            {/* Outer body */}
            <path d="M192.548 0.25C211.738 0.25 227.301 15.5684 227.301 34.4727V417.387C227.301 436.291 211.738 451.609 192.548 451.609H35.0029C15.8131 451.609 0.25 436.291 0.25 417.387V34.4727C0.25 15.5685 15.8131 0.250059 35.0029 0.25H192.548Z" fill="#F9FAFB" stroke="#EFF1F4" strokeWidth="0.5" />
            {/* White screen background */}
            <path d="M169.388 18.4507C176.045 18.4363 182.728 18.3336 189.4 18.4878C198.419 18.6976 205.801 24.5205 208.337 33.1489V33.1499C208.813 34.7742 209.052 36.4585 209.047 38.1509C209.039 51.5419 209.04 64.9321 209.049 78.3208C209.049 188.645 209.053 298.972 209.061 409.302C209.061 412.09 208.921 414.915 207.832 417.631C204.94 424.84 199.641 429.156 191.989 430.542L191.99 430.542C190.627 430.793 189.254 430.792 187.938 430.792H42.998C41.2406 430.792 39.4564 430.816 37.6797 430.755V430.754C28.1294 430.451 20.2682 423.728 18.4424 414.405L18.3594 413.958C18.1164 412.553 18.0947 411.156 18.0947 409.795C18.0911 368.299 18.0898 326.806 18.0918 285.317V224.723C18.0915 224.717 18.0898 224.71 18.0898 224.704C18.0898 167.937 18.0902 111.171 18.0918 54.4048C18.0918 48.8426 18.0148 43.2535 18.1523 37.6763C18.3741 28.7266 25.1034 20.8076 33.8535 18.9478L34.4424 18.8296C35.8189 18.5719 37.2168 18.4414 38.6182 18.4399C44.8435 18.4411 51.0683 18.4395 57.292 18.4351V18.436C58.2061 18.4337 59.1562 18.5775 59.917 19.3237L60.0664 19.481C60.6439 20.1332 60.8386 20.9001 60.8535 21.686C60.8802 23.0185 60.9055 24.2972 61.1797 25.5356C62.2175 30.22 66.2449 33.5613 71.0557 33.5991C78.7224 33.6604 86.3894 33.6204 94.0635 33.6216C114.304 33.6228 134.545 33.6228 154.786 33.6216C155.84 33.6216 156.827 33.6263 157.802 33.4224H157.804C162.44 32.4787 165.843 28.5158 166.068 23.8003V23.7983C166.088 23.4267 166.096 23.0541 166.105 22.6694C166.115 22.2881 166.127 21.8967 166.155 21.5044C166.221 20.6031 166.534 19.8294 167.108 19.2798C167.684 18.7284 168.471 18.4527 169.388 18.4507Z" fill="#FFFFFF" />
            {/* Screenshot clipped to screen area */}
            <image
              href="/enterprise/mobile_screenshot.png"
              x="18" y="18" width="191" height="413"
              preserveAspectRatio="xMidYMin slice"
              clipPath="url(#mobile-screen-clip)"
            />
            {/* Screen border */}
            <path d="M169.388 18.4507C176.045 18.4363 182.728 18.3336 189.4 18.4878C198.419 18.6976 205.801 24.5205 208.337 33.1489V33.1499C208.813 34.7742 209.052 36.4585 209.047 38.1509C209.039 51.5419 209.04 64.9321 209.049 78.3208C209.049 188.645 209.053 298.972 209.061 409.302C209.061 412.09 208.921 414.915 207.832 417.631C204.94 424.84 199.641 429.156 191.989 430.542L191.99 430.542C190.627 430.793 189.254 430.792 187.938 430.792H42.998C41.2406 430.792 39.4564 430.816 37.6797 430.755V430.754C28.1294 430.451 20.2682 423.728 18.4424 414.405L18.3594 413.958C18.1164 412.553 18.0947 411.156 18.0947 409.795C18.0911 368.299 18.0898 326.806 18.0918 285.317V224.723C18.0915 224.717 18.0898 224.71 18.0898 224.704C18.0898 167.937 18.0902 111.171 18.0918 54.4048C18.0918 48.8426 18.0148 43.2535 18.1523 37.6763C18.3741 28.7266 25.1034 20.8076 33.8535 18.9478L34.4424 18.8296C35.8189 18.5719 37.2168 18.4414 38.6182 18.4399C44.8435 18.4411 51.0683 18.4395 57.292 18.4351V18.436C58.2061 18.4337 59.1562 18.5775 59.917 19.3237L60.0664 19.481C60.6439 20.1332 60.8386 20.9001 60.8535 21.686C60.8802 23.0185 60.9055 24.2972 61.1797 25.5356C62.2175 30.22 66.2449 33.5613 71.0557 33.5991C78.7224 33.6604 86.3894 33.6204 94.0635 33.6216C114.304 33.6228 134.545 33.6228 154.786 33.6216C155.84 33.6216 156.827 33.6263 157.802 33.4224H157.804C162.44 32.4787 165.843 28.5158 166.068 23.8003V23.7983C166.088 23.4267 166.096 23.0541 166.105 22.6694C166.115 22.2881 166.127 21.8967 166.155 21.5044C166.221 20.6031 166.534 19.8294 167.108 19.2798C167.684 18.7284 168.471 18.4527 169.388 18.4507Z" stroke="#E1E1E1" strokeLinejoin="round" fill="none" />
            {/* Notch speaker */}
            <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d="M98.547 24.4338C98.5467 23.4675 99.3426 22.6839 100.325 22.6837L118.567 22.6792C119.549 22.6789 120.345 23.4621 120.345 24.4284C120.345 25.3947 119.549 26.1783 118.567 26.1785L100.326 26.183C99.3435 26.1833 98.5472 25.4001 98.547 24.4338Z" fill="#C8C8C8" />
            {/* Notch camera */}
            <path opacity="0.546196" fillRule="evenodd" clipRule="evenodd" d="M125.41 24.4259C125.41 23.4623 126.204 22.6773 127.183 22.677C128.162 22.6768 128.956 23.4615 128.956 24.425C128.957 25.3886 128.163 26.1737 127.184 26.1739C126.205 26.1741 125.411 25.3895 125.41 24.4259Z" fill="#C8C8C8" />
          </svg>
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
        <StarOnGitHubButton />
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

/* ─── Partnership Section ─────────────────────────────── */

const PartnershipSection = () => (
  <section className="relative pt-16 pb-12 md:pt-28 md:pb-20">
    <div className="mx-auto max-w-[1120px] px-6 lg:px-0">
      {/* Logo lockup — section anchor */}
      <div className="flex flex-col items-center justify-between gap-6 md:flex-row md:items-end md:gap-8">
        <div className="flex flex-col items-center gap-3 md:flex-row md:gap-8">
          <div className="flex items-center gap-3">
            <img
              src="/enterprise/thunderbolt-logo.png"
              alt="Thunderbolt"
              className="size-[44px] md:size-[56px]"
            />
            <span className="text-[28px] font-medium tracking-tight text-[#101828] md:text-[40px]">
              Thunderbolt
            </span>
          </div>
          <span
            className="text-[32px] font-light leading-none text-[#98a2b3] md:text-[44px]"
            aria-hidden="true"
          >
            +
          </span>
          <img
            src="/enterprise/deepset.png"
            alt="deepset"
            className="mt-2 h-[32px] w-auto md:mt-0 md:h-[40px]"
          />
        </div>
        <a
          href="https://www.deepset.ai/news/sovereign-ai-stack-mozilla-thunderbolt-haystack"
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex shrink-0 items-center gap-2 self-center font-mono text-sm font-bold uppercase tracking-wider text-[#344054] transition-colors hover:text-[#101828] md:self-auto"
        >
          Read the announcement from deepset
          <span className="transition-transform group-hover:translate-x-0.5" aria-hidden="true">
            &rarr;
          </span>
        </a>
      </div>
      {/* Two subparts */}
      <div className="mt-12 grid gap-10 md:mt-16 md:grid-cols-2 md:gap-x-16 md:gap-y-12 lg:gap-x-24">
        {/* Built for Enterprise */}
        <div className="md:border-l md:border-[#d0d5dd]/70 md:pl-10 lg:pl-14">
          <div className="flex items-center gap-3">
            <img src="/enterprise/icon-factory-24.svg" alt="" className="size-6" />
            <h3 className="text-xl font-semibold leading-7 tracking-[-0.2px] text-[#101828] md:text-2xl">
              Built for Enterprise
            </h3>
          </div>
          <p className="mt-4 text-base leading-7 text-[#667085] md:text-[17px] md:leading-7">
            Native apps across web, desktop, and mobile. Forward-Deployed Engineering support through a
            partnership with deepset&rsquo;s Haystack. MCP integration with your systems. Open source you
            can audit and customize as your business needs evolve.
          </p>
        </div>
        {/* European Delivery */}
        <div className="md:border-l md:border-[#d0d5dd]/70 md:pl-10 lg:pl-14">
          <div className="flex items-center gap-3">
            <img src="/enterprise/icon-map-pin.svg" alt="" className="size-6" />
            <h3 className="text-xl font-semibold leading-7 tracking-[-0.2px] text-[#101828] md:text-2xl">
              European Delivery
            </h3>
          </div>
          <p className="mt-4 text-base leading-7 text-[#667085] md:text-[17px] md:leading-7">
            Partnership with deepset for sovereign deployments across the EU. Thunderbolt&rsquo;s
            open-source client pairs with Haystack&rsquo;s orchestration platform into a unified,
            sovereign stack &mdash; giving organizations long-term control over how AI is built, run, and
            experienced, without trade-offs between capability and control.
          </p>
        </div>
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
            <span className="hidden md:inline">Ryan Sipes, CEO, MZLA Technologies</span>
            <span className="md:hidden">Ryan Sipes,<br />CEO, MZLA Technologies</span>
          </p>
        </div>
      </div>
    </div>
  </section>
)

/* ─── As Featured In ──────────────────────────────────── */

const featuredArticles = [
  {
    name: 'Ars Technica',
    logo: '/ars_technica.svg',
    url: 'https://arstechnica.com/ai/2026/04/mozilla-launches-thunderbolt-ai-client-with-focus-on-self-hosted-infrastructure/',
    logoClass: 'h-12 w-auto md:h-14',
  },
  {
    name: 'The Register',
    logo: '/the_register.svg',
    url: 'https://www.theregister.com/2026/04/16/mozilla_thunderbolt_enterprise_ai_client/',
    logoClass: 'h-20 w-auto md:h-24',
  },
]

/** Appends UTM params so our outbound press clicks show up in each publisher's analytics. */
const withUtm = (url: string) => {
  if (!url.startsWith('http')) return url
  const u = new URL(url)
  u.searchParams.set('utm_source', 'thunderbolt.io')
  u.searchParams.set('utm_medium', 'referral')
  u.searchParams.set('utm_campaign', 'mzla_thunderbolt')
  return u.toString()
}

const FeaturedInSection = () => (
  <section className="relative pt-8 pb-0 md:pt-12 md:pb-0">
    <div className="mx-auto max-w-[1120px] px-6 lg:px-0">
      <p className="text-center font-['Mozilla_Text',sans-serif] text-[19px] font-normal uppercase leading-[26px] tracking-[-0.38px] text-[#344054]">
        As Featured In
      </p>
      <div className="mt-10 flex flex-col items-center justify-center gap-10 md:flex-row md:gap-20">
        {featuredArticles.map((article) => (
          <a
            key={article.name}
            href={withUtm(article.url)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Read the ${article.name} article`}
            className="inline-flex items-center opacity-70 transition-opacity hover:opacity-100"
          >
            <img src={article.logo} alt={article.name} className={article.logoClass} />
          </a>
        ))}
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
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <StarOnGitHubButton />
        <EnterpriseInquiriesButton />
      </div>
    </div>
  </section>
)

/* ─── Mobile Sticky Footer CTA ───────────────────────── */

const MobileFooterCTA = () => (
  <div className="fixed inset-x-0 bottom-0 z-50 bg-white/20 backdrop-blur-[32px] px-6 py-4 md:hidden">
    <StarOnGitHubButton fullWidth />
  </div>
)

/* ─── Page ────────────────────────────────────────────── */

export const EnterprisePage = () => {
  return (
  <div className="relative min-h-screen overflow-x-hidden bg-[#f9fafb]">
    <BackgroundGrid />
    <Header
      banner={
        <a
          href="/blog/mozilla-introduces-thunderbolt"
          className="group flex w-full items-center justify-center gap-2 bg-gradient-to-r from-[#8b5cf6] from-20% via-[#ea580c] via-60% to-[#fbbf24] px-4 py-2.5 text-sm font-semibold text-white"
        >
          <span>
            Thunderbolt is here! <span className="text-white/80">&mdash; Read the announcement</span>
          </span>
          <span className="text-white/80 transition-transform group-hover:translate-x-0.5">&rarr;</span>
        </a>
      }
      action={<StarCountBadge />}
    />
    <main className="relative pt-[144px]">
      <Hero />
      <FeatureCards />
      <CompromiseSection />
      <PartnershipSection />
      <QuoteSection />
      <FeaturedInSection />
      <CTASection />
    </main>
    <FooterSection className="relative z-10 bg-[#f9fafb] pb-24 md:pb-16" />
    <MobileFooterCTA />
  </div>
  )
}

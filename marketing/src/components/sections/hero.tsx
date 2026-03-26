import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { AnimatedSection } from '@/components/shared/animated-section'

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1 } },
}
const item = {
  hidden: { opacity: 0, y: 20 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, ease: [0.21, 0.47, 0.32, 0.98] as const },
  },
}

const TYPE_SPEED = 40
const DELETE_SPEED = 50
const PAUSE_BEFORE_DELETE = 800
const PAUSE_BEFORE_RETYPE = 300

type Phase = 'typing' | 'deleting' | 'retyping' | 'done'

/**
 * Types "The privacy-first / AI assistant for / enterprise",
 * then backspaces "enterprise" and retypes "your enterprise"
 * where "your" is marked for italic rendering.
 */
const useTypewriter = (startDelay: number) => {
  const base = 'The privacy-first\nAI assistant for\n'
  const firstEnding = 'enterprise'
  const secondEnding = 'your enterprise'
  const fullFirst = base + firstEnding

  const [phase, setPhase] = useState<Phase>('typing')
  const [idx, setIdx] = useState(0)
  const [started, setStarted] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setStarted(true), startDelay)
    return () => clearTimeout(t)
  }, [startDelay])

  useEffect(() => {
    if (!started) return

    if (phase === 'typing') {
      if (idx >= fullFirst.length) {
        const t = setTimeout(() => { setPhase('deleting'); setIdx(firstEnding.length) }, PAUSE_BEFORE_DELETE)
        return () => clearTimeout(t)
      }
      const t = setTimeout(() => setIdx((i) => i + 1), TYPE_SPEED)
      return () => clearTimeout(t)
    }

    if (phase === 'deleting') {
      if (idx <= 0) {
        const t = setTimeout(() => { setPhase('retyping'); setIdx(0) }, PAUSE_BEFORE_RETYPE)
        return () => clearTimeout(t)
      }
      const t = setTimeout(() => setIdx((i) => i - 1), DELETE_SPEED)
      return () => clearTimeout(t)
    }

    if (phase === 'retyping') {
      if (idx >= secondEnding.length) { setPhase('done'); return }
      const t = setTimeout(() => setIdx((i) => i + 1), TYPE_SPEED)
      return () => clearTimeout(t)
    }
  }, [started, phase, idx, fullFirst.length, firstEnding.length, secondEnding.length])

  // Build the visible text
  let visibleText: string
  let italicEnd = 0 // how many chars of the last line are italic

  if (phase === 'typing') {
    visibleText = fullFirst.slice(0, idx)
  } else if (phase === 'deleting') {
    visibleText = base + firstEnding.slice(0, idx)
  } else {
    // retyping or done — "your " (5 chars) is italic
    const typed = secondEnding.slice(0, idx)
    visibleText = base + typed
    italicEnd = Math.min(5, idx) // "your " = 5 chars including space
  }

  const lines = visibleText.split('\n')
  const done = phase === 'done'

  return { lines, italicEnd, done, started }
}

export const Hero = () => {
  const { lines, italicEnd, done, started } = useTypewriter(400)

  return (
  <section className="relative overflow-hidden pt-24 md:pt-28">
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="w-full px-6 pt-12 lg:px-10"
    >
      {/* Split headline + description */}
      <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <motion.h1
          variants={item}
          className="min-h-[calc(1.02em*3+0.1em)] max-w-2xl text-[clamp(2.5rem,5.5vw,5.5rem)] leading-[1.02] font-medium tracking-[-0.04em] text-black"
        >
          {lines.map((line, i, arr) => {
            const isLast = i === arr.length - 1
            return (
              <span key={i}>
                {isLast && italicEnd > 0 ? (
                  <>
                    <em className="italic">{line.slice(0, italicEnd)}</em>
                    {line.slice(italicEnd)}
                  </>
                ) : (
                  line
                )}
                {i < arr.length - 1 && <br />}
              </span>
            )
          })}
          {started && (
            <span
              className={`inline-block h-[1em] w-[2px] translate-y-[0.1em] bg-black align-baseline ${
                done ? 'animate-blink' : ''
              }`}
            />
          )}
        </motion.h1>

        <motion.div variants={item} className="max-w-md lg:pb-2">
          <p className="text-[clamp(1rem,1.2vw,1.25rem)] leading-[1.5] text-black/60">
            Thunderbolt delivers zero-knowledge AI with bring-your-own models,
            local-first storage, and full self-hosting — powering complete
            enterprise autonomy
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="#"
              className="rounded-md border border-black/15 px-5 py-2.5 font-mono text-xs font-medium tracking-[0.06em] uppercase text-black transition-all hover:bg-black/[0.04]"
            >
              Book a Demo
            </a>
            <a
              href="#"
              className="rounded-md bg-black px-5 py-2.5 font-mono text-xs font-medium tracking-[0.06em] uppercase text-white transition-all hover:bg-black/85"
            >
              Try for Free
            </a>
          </div>
        </motion.div>
      </div>
    </motion.div>

    {/* Full-width gradient graphic — edge to edge */}
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.3, duration: 0.8 }}
      className="mt-12 w-full md:mt-16"
    >
      <HeroGraphic />
    </motion.div>

    {/* Logo ticker */}
    <AnimatedSection delay={0.6}>
      <LogoTicker />
    </AnimatedSection>
  </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Animated shield / data-sovereignty visualization                   */
/* ------------------------------------------------------------------ */

const RINGS = [
  { radius: 200, duration: 60, direction: 1, color: '#06b6d4', dotSize: 10 },
  { radius: 150, duration: 50, direction: -1, color: '#d946ef', dotSize: 8 },
  { radius: 100, duration: 40, direction: 1, color: '#f97316', dotSize: 7 },
]

const HeroGraphic = () => (
  <div className="relative flex h-[380px] items-center justify-center overflow-hidden md:h-[520px]">
    {/* Full-width gradient wash */}
    <div className="absolute inset-0 bg-gradient-to-r from-cyan-300 via-fuchsia-300/80 to-orange-300 opacity-50" />
    <div className="absolute inset-0 bg-gradient-to-t from-white via-white/20 to-transparent" />

    {/* LEFT SIDE — feature pills (animate in once, then static) */}
    <div className="absolute left-6 top-1/2 hidden -translate-y-1/2 space-y-4 lg:block xl:left-16">
      {[
        { label: 'Zero server logs', delay: 0.8 },
        { label: 'On-device encryption', delay: 1.0 },
        { label: 'GDPR compliant', delay: 1.2 },
        { label: 'SOC 2 ready', delay: 1.4 },
      ].map((pill) => (
        <motion.div
          key={pill.label}
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: pill.delay, duration: 0.6 }}
          className="flex items-center gap-2.5 rounded-lg bg-white/80 px-4 py-2.5 shadow-lg shadow-black/5 backdrop-blur-sm"
        >
          <span className="size-2 rounded-full bg-emerald-500" />
          <span className="text-sm font-medium text-black/70">{pill.label}</span>
        </motion.div>
      ))}
    </div>

    {/* RIGHT SIDE — architecture nodes (animate in once, then static) */}
    <div className="absolute right-6 top-1/2 hidden -translate-y-1/2 space-y-4 lg:block xl:right-16">
      {[
        { label: 'Your Device', sub: 'SQLite + AES-256', delay: 0.9, accent: 'bg-black' },
        { label: 'LLM Provider', sub: 'API key on-device only', delay: 1.1, accent: 'bg-cyan-500' },
        { label: 'Sync Engine', sub: 'E2E encrypted', delay: 1.3, accent: 'bg-fuchsia-500' },
        { label: 'Our Servers', sub: 'Never in the loop', delay: 1.5, accent: 'bg-black/20' },
      ].map((node) => (
        <motion.div
          key={node.label}
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: node.delay, duration: 0.6 }}
          className={`rounded-lg bg-white/80 px-4 py-2.5 shadow-lg shadow-black/5 backdrop-blur-sm ${
            node.label === 'Our Servers' ? 'opacity-40 line-through' : ''
          }`}
        >
          <div className="flex items-center gap-2">
            <span className={`size-2 rounded-full ${node.accent}`} />
            <span className="text-sm font-medium text-black/70">{node.label}</span>
          </div>
          <span className="ml-4 font-mono text-[10px] text-black/35">{node.sub}</span>
        </motion.div>
      ))}
    </div>

    {/* CONCENTRIC ORBITING RINGS — slow smooth rotation only */}
    <div className="absolute inset-0 flex items-center justify-center">
      {RINGS.map((ring) => (
        <motion.div
          key={ring.radius}
          className="absolute rounded-full border border-black/[0.06]"
          style={{ width: ring.radius * 2, height: ring.radius * 2 }}
          animate={{ rotate: ring.direction * 360 }}
          transition={{
            duration: ring.duration,
            repeat: Infinity,
            ease: 'linear',
          }}
        >
          <motion.div
            className="absolute -top-1 left-1/2 -translate-x-1/2 rounded-full"
            style={{
              width: ring.dotSize,
              height: ring.dotSize,
              background: ring.color,
              boxShadow: `0 0 16px ${ring.color}90`,
            }}
          />
          <motion.div
            className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full"
            style={{
              width: ring.dotSize * 0.6,
              height: ring.dotSize * 0.6,
              background: ring.color,
              opacity: 0.4,
            }}
          />
        </motion.div>
      ))}
    </div>

    {/* CENTER SHIELD — layered gradient with glow */}
    <motion.div
      initial={{ scale: 0.5, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ delay: 0.5, duration: 0.9, ease: [0.21, 0.47, 0.32, 0.98] as const }}
      className="relative z-10"
    >
      {/* Outer glow */}
      <div className="absolute -inset-8 rounded-full bg-gradient-to-br from-cyan-400/30 via-fuchsia-400/20 to-orange-400/30 blur-2xl" />

      {/* Glass container */}
      <div className="relative flex size-32 items-center justify-center rounded-[1.75rem] border border-white/60 bg-white/70 shadow-2xl shadow-fuchsia-500/10 backdrop-blur-xl md:size-44 md:rounded-[2.25rem]">
        {/* Inner gradient ring */}
        <div className="absolute inset-2 rounded-[1.25rem] bg-gradient-to-br from-cyan-400 via-fuchsia-500 to-orange-400 opacity-[0.08] md:inset-3 md:rounded-[1.5rem]" />

        <svg viewBox="0 0 64 64" fill="none" className="relative size-16 md:size-24">
          <defs>
            <linearGradient id="shield-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#06b6d4" />
              <stop offset="50%" stopColor="#d946ef" />
              <stop offset="100%" stopColor="#f97316" />
            </linearGradient>
            <linearGradient id="shield-grad-dark" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#0891b2" />
              <stop offset="50%" stopColor="#c026d3" />
              <stop offset="100%" stopColor="#ea580c" />
            </linearGradient>
          </defs>

          {/* Shield body — filled gradient */}
          <motion.path
            d="M32 4L8 18v14c0 14.8 10.24 28.64 24 32 13.76-3.36 24-17.2 24-32V18L32 4z"
            fill="url(#shield-grad)"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.7, duration: 0.6 }}
            style={{ transformOrigin: 'center' }}
          />

          {/* Shield outline for definition */}
          <motion.path
            d="M32 4L8 18v14c0 14.8 10.24 28.64 24 32 13.76-3.36 24-17.2 24-32V18L32 4z"
            stroke="url(#shield-grad-dark)"
            strokeWidth="1.5"
            fill="none"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ delay: 0.6, duration: 1.0, ease: 'easeInOut' }}
          />

          {/* Inner highlight for depth */}
          <motion.path
            d="M32 10L14 21v11c0 11.5 7.94 22.22 18 24.8V10z"
            fill="white"
            opacity="0.2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.2 }}
            transition={{ delay: 1.2, duration: 0.5 }}
          />

          {/* Checkmark */}
          <motion.path
            d="M22 32l7 7 13-14"
            stroke="white"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ delay: 1.5, duration: 0.5, ease: 'easeOut' }}
          />
        </svg>
      </div>
    </motion.div>

    {/* FLOATING DATA BLOCKS — animate to position once, then static */}
    {[
      { x: -180, y: -80, delay: 0.7, label: 'conversations', w: 'w-32' },
      { x: 160, y: -60, delay: 0.9, label: 'api_keys', w: 'w-24' },
      { x: -140, y: 80, delay: 1.1, label: 'documents', w: 'w-28' },
      { x: 190, y: 70, delay: 1.3, label: 'user_data', w: 'w-24' },
      { x: -30, y: -160, delay: 1.0, label: 'embeddings', w: 'w-26' },
      { x: 40, y: 150, delay: 1.2, label: 'preferences', w: 'w-28' },
    ].map((block, i) => (
      <motion.div
        key={i}
        className="absolute z-20 hidden md:block"
        initial={{ opacity: 0, x: 0, y: 0 }}
        animate={{ opacity: 1, x: block.x, y: block.y }}
        transition={{
          delay: block.delay,
          duration: 0.7,
          ease: [0.21, 0.47, 0.32, 0.98] as const,
        }}
      >
        <div className="rounded-lg bg-white/90 px-3 py-2 shadow-lg shadow-black/5 backdrop-blur-sm">
          <div className="font-mono text-[10px] text-black/30">local://</div>
          <div className="font-mono text-xs font-medium text-black/70">
            {block.label}
          </div>
          <div
            className={`mt-1 h-1 ${block.w} rounded-full bg-gradient-to-r from-cyan-400 to-fuchsia-400 opacity-40`}
          />
        </div>
      </motion.div>
    ))}

    {/* STATIC PARTICLES — positioned around the scene, no movement */}
    {Array.from({ length: 16 }).map((_, i) => {
      const angle = (i / 16) * Math.PI * 2
      const radius = 220 + (i % 3) * 50
      return (
        <motion.div
          key={`p-${i}`}
          className="absolute size-1.5 rounded-full bg-black/[0.08]"
          style={{
            left: `calc(50% + ${Math.cos(angle) * radius}px)`,
            top: `calc(50% + ${Math.sin(angle) * radius * 0.55}px)`,
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 + i * 0.08, duration: 0.4 }}
        />
      )
    })}
  </div>
)

/* ------------------------------------------------------------------ */
/*  Logo ticker — the one exception: smooth linear scroll is fine      */
/* ------------------------------------------------------------------ */

const logos = [
  'Mozilla',
  'Thunderbird',
  'MZLA',
  'Enterprise Co.',
  'Acme Corp',
  'GlobalTech',
  'SecureNet',
  'DataVault',
  'CloudFirst',
  'TrustLayer',
]

const LogoTicker = () => (
  <div className="relative overflow-hidden border-y border-black/[0.06] bg-white py-8">
    <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-white to-transparent" />
    <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-white to-transparent" />

    <motion.div
      animate={{ x: ['0%', '-50%'] }}
      transition={{ duration: 30, repeat: Infinity, ease: 'linear' }}
      className="flex w-max items-center gap-16"
    >
      {[...logos, ...logos].map((name, i) => (
        <span
          key={`${name}-${i}`}
          className="whitespace-nowrap font-mono text-sm font-medium tracking-tight text-black/25 uppercase select-none"
        >
          {name}
        </span>
      ))}
    </motion.div>
  </div>
)

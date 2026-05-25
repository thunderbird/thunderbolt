/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  Bot,
  ChevronDown,
  ChevronLeft,
  Code,
  Cpu,
  Download,
  Info,
  LayoutGrid,
  Menu,
  Plug,
  Puzzle,
  Search,
  Server,
  User,
  X,
  Zap,
} from 'lucide-react'
import * as AccordionPrimitive from '@radix-ui/react-accordion'
import { AnimatePresence, motion } from 'framer-motion'
import { type ComponentType, type ReactNode, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useSidebar } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { cards, defaultInstalledNames, type Card as MarketplaceCard } from '@/skills/marketplace-data'
import { cn } from '@/lib/utils'

const categories: { key: string; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { key: 'skills', label: 'Skills', icon: Zap },
  { key: 'integrations', label: 'Connector', icon: Plug },
  { key: 'mcp', label: 'MCP Servers', icon: Server },
  { key: 'models', label: 'Models', icon: Cpu },
  { key: 'agents', label: 'Agents', icon: Bot },
  { key: 'widget', label: 'Widget', icon: LayoutGrid },
  { key: 'extensions', label: 'Extensions', icon: Puzzle },
]

type InstallFilter = 'all' | 'installed' | 'not-installed'

const filterLabel: Record<InstallFilter, string> = {
  all: 'All',
  installed: 'Installed',
  'not-installed': 'Not Installed',
}

const applyFilter = (cards: MarketplaceCard[], filter: InstallFilter, installedNames: Set<string>) => {
  if (filter === 'installed') {
    return cards.filter((c) => installedNames.has(c.name))
  }
  if (filter === 'not-installed') {
    return cards.filter((c) => !installedNames.has(c.name))
  }
  return cards
}

const InstallFilterSelect = ({ value, onChange }: { value: InstallFilter; onChange: (v: InstallFilter) => void }) => {
  const options: InstallFilter[] = ['all', 'installed', 'not-installed']
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="h-9 justify-between gap-1.5 border-border bg-transparent dark:bg-transparent px-3 text-sm font-normal text-foreground shadow-none hover:bg-accent dark:hover:bg-accent [&_svg:not([class*='size-'])]:size-3.5"
        >
          <span className="grid grid-cols-1 grid-rows-1 text-left [&>*]:col-start-1 [&>*]:row-start-1">
            {options.map((opt) => (
              <span
                key={opt}
                className={opt === value ? '' : 'invisible'}
                aria-hidden={opt === value ? undefined : true}
              >
                {filterLabel[opt]}
              </span>
            ))}
          </span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="flex min-w-44 flex-col gap-0 rounded-xl border border-border bg-card px-2 py-3"
      >
        {options.map((opt) => (
          <DropdownMenuItem
            key={opt}
            onClick={() => onChange(opt)}
            className={cn('h-9 gap-1.5 rounded-lg px-2 text-sm', opt === value && 'bg-accent text-accent-foreground')}
          >
            <span className="flex-1">{filterLabel[opt]}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const CategoryTab = ({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string
  icon: ComponentType<{ className?: string }>
  active?: boolean
  onClick?: () => void
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'relative isolate inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-sm font-normal text-foreground transition-colors',
      !active && 'hover:bg-accent',
    )}
  >
    {active && (
      <motion.span
        layoutId="categoryTabActiveBg"
        className="absolute inset-0 rounded-lg bg-accent"
        transition={{ type: 'spring', damping: 35, stiffness: 400, mass: 0.8 }}
      />
    )}
    <Icon className="relative z-10 size-4 text-foreground" />
    <span className="relative z-10">{label}</span>
  </button>
)

const InstallPill = ({ installed, onToggle }: { installed: boolean; onToggle: () => void }) => (
  <Button
    type="button"
    variant={installed ? 'outline' : 'default'}
    size="sm"
    onClick={(e) => {
      e.stopPropagation()
      onToggle()
    }}
    aria-label={installed ? 'Uninstall' : 'Install'}
    className="h-6 shrink-0 px-2 text-sm font-normal"
  >
    {installed ? 'Uninstall' : 'Install'}
  </Button>
)

const SkillTile = ({
  card,
  installed,
  active,
  onToggleInstall,
}: {
  card: MarketplaceCard
  installed: boolean
  active?: boolean
  onToggleInstall: () => void
}) => (
  <div
    className={cn(
      'flex h-[170px] flex-col gap-0.5 overflow-hidden rounded-xl p-4 transition-colors',
      active
        ? 'border-2 border-border bg-border'
        : 'border-2 border-transparent bg-secondary hover:bg-accent dark:bg-sidebar dark:hover:bg-accent',
    )}
  >
    <div className="flex items-center justify-between gap-3">
      <h3 className="truncate text-lg text-foreground">{card.name}</h3>
      <InstallPill installed={installed} onToggle={onToggleInstall} />
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <span className="flex items-center gap-1 whitespace-nowrap">
        <User size={14} strokeWidth={1.75} />
        {card.author}
      </span>
      <span className="flex items-center gap-1 whitespace-nowrap">
        <Download size={14} strokeWidth={1.75} />
        {card.downloads.toLocaleString()}
      </span>
    </div>
    <p className="mt-2 line-clamp-3 text-base leading-snug text-foreground/85">{card.description}</p>
  </div>
)

const SkillPreview = ({
  card,
  installed,
  onToggleInstall,
  onClose,
}: {
  card: MarketplaceCard
  installed: boolean
  onToggleInstall: (name: string) => void
  onClose: () => void
}) => (
  <div className="flex h-full flex-col gap-4 overflow-hidden bg-background px-4 py-4 md:px-6 text-foreground">
    <header className="flex flex-col gap-4 md:gap-2">
      <div className="relative flex h-9 items-center">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          onClick={onClose}
          className="size-8 absolute left-0 shrink-0 rounded-md border border-border text-muted-foreground hover:text-foreground md:hidden"
        >
          <ChevronLeft className="size-5" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate px-10 text-center text-xl text-foreground md:px-0 md:pr-10 md:text-left">
          {card.name}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-0 hidden shrink-0 text-muted-foreground hover:text-foreground md:flex"
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="flex items-center gap-1 whitespace-nowrap">
          <User className="size-5 md:size-3.5" strokeWidth={1.75} />
          {card.author}
        </span>
        <span className="flex items-center gap-1 whitespace-nowrap">
          <Download className="size-5 md:size-3.5" strokeWidth={1.75} />
          {card.downloads.toLocaleString()}
        </span>
      </div>
    </header>

    <div className="flex items-center gap-2">
      <Button variant="outline" size="lg" className="h-9 border-border px-3 text-sm font-normal">
        <Code size={16} />
        Source Code
      </Button>
      <Button
        variant={installed ? 'outline' : 'default'}
        size="lg"
        className={`h-9 px-3 text-sm font-normal ${installed ? 'border-border' : ''}`}
        onClick={() => onToggleInstall(card.name)}
      >
        {installed ? 'Uninstall' : 'Install'}
      </Button>
    </div>

    <Accordion
      type="multiple"
      defaultValue={['description', 'instructions']}
      className="flex min-h-0 flex-1 flex-col gap-4"
    >
      <AccordionItem value="description" className="rounded-xl border-b-0 bg-secondary px-4 dark:bg-sidebar">
        <AccordionTrigger className="py-3 text-sm leading-tight text-muted-foreground hover:no-underline">
          <div className="flex items-center gap-0.5">
            <span>Description</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="img"
                  aria-label="What is this for?"
                  className="ml-1 inline-flex items-center text-muted-foreground hover:text-foreground"
                >
                  <Info size={14} strokeWidth={1.75} />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Helps the agent decide when to use this skill. Be specific about when it applies.
              </TooltipContent>
            </Tooltip>
          </div>
        </AccordionTrigger>
        <AccordionContent className="pb-4 pt-0">
          <p className="text-base leading-snug text-foreground">{card.description}</p>
        </AccordionContent>
      </AccordionItem>

      {/* Instructions uses AccordionPrimitive directly so we can apply flex-1
          to fill remaining vertical space when open. The shared
          AccordionContent's height-keyframe animation conflicts with flex-1
          sizing, so this item snaps open/closed without animation. */}
      <AccordionPrimitive.Item
        value="instructions"
        className="flex flex-col rounded-xl bg-secondary px-4 data-[state=open]:min-h-0 data-[state=open]:flex-1 dark:bg-sidebar"
      >
        <AccordionPrimitive.Header className="flex">
          <AccordionPrimitive.Trigger className="flex flex-1 items-center justify-between gap-4 py-3 text-sm leading-tight text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&[data-state=open]>svg]:rotate-180">
            Instructions
            <ChevronDown className="text-muted-foreground pointer-events-none size-4 shrink-0 transition-transform duration-200" />
          </AccordionPrimitive.Trigger>
        </AccordionPrimitive.Header>
        <AccordionPrimitive.Content className="overflow-hidden data-[state=open]:flex data-[state=open]:min-h-0 data-[state=open]:flex-1 data-[state=open]:flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap pb-4 text-base leading-snug text-foreground">
            {card.instruction}
          </div>
        </AccordionPrimitive.Content>
      </AccordionPrimitive.Item>
    </Accordion>
  </div>
)

const slideMs = 320
const slideEasing = 'cubic-bezier(0.32, 0.72, 0, 1)'

const SlideInAside = ({ open, children }: { open: boolean; children: ReactNode }) => {
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const visible = open && entered
  return (
    <aside
      className="shrink-0 overflow-hidden border-l border-border/50"
      style={{
        width: visible ? '50%' : '0px',
        borderLeftWidth: visible ? '1px' : '0',
        transition: `width ${slideMs}ms ${slideEasing}, border-left-width ${slideMs}ms ${slideEasing}`,
      }}
    >
      <div
        className="h-full w-full"
        style={{
          transform: visible ? 'translateX(0)' : 'translateX(100%)',
          transition: `transform ${slideMs}ms ${slideEasing}`,
          willChange: 'transform',
        }}
      >
        {children}
      </div>
    </aside>
  )
}

export const Marketplace = () => {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const canGoBack = searchParams.get('from') === 'skills'
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [closingName, setClosingName] = useState<string | null>(null)
  const [filter, setFilter] = useState<InstallFilter>('all')
  const [activeCategory, setActiveCategory] = useState<string>('skills')
  // Local install state for the visual shell — backend will replace with a per-user fetch + install/uninstall mutations.
  const [installedNames, setInstalledNames] = useState<Set<string>>(() => new Set(defaultInstalledNames))
  const { isMobile } = useIsMobile()
  const { toggleSidebar } = useSidebar()

  const toggleInstall = (name: string) => {
    setInstalledNames((prev) => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  const visible = useMemo(
    () =>
      applyFilter(cards, filter, installedNames)
        .slice()
        .sort((a, b) => Number(installedNames.has(b.name)) - Number(installedNames.has(a.name))),
    [filter, installedNames],
  )

  const visibleSelectedName = selectedName ?? closingName
  const selected = visibleSelectedName ? (cards.find((c) => c.name === visibleSelectedName) ?? null) : null
  const isClosing = closingName !== null
  const previewOpen = selectedName !== null

  const closePreview = () => {
    if (!selectedName) {
      return
    }
    setClosingName(selectedName)
    setSelectedName(null)
    window.setTimeout(() => setClosingName(null), slideMs)
  }

  const openPreview = (name: string) => {
    setClosingName(null)
    setSelectedName(name)
  }

  // On mobile, the grid stays mounted and the preview slides in from the right
  // over the top. Desktop uses the SlideInAside below for a side-by-side reveal.
  return (
    <section className="relative flex h-full flex-1 overflow-hidden bg-background text-foreground">
      {isMobile && (
        <AnimatePresence>
          {selected && (
            <motion.div
              key="mobile-preview"
              className="absolute inset-0 z-10 flex h-full w-full flex-col overflow-y-auto bg-background"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 35, stiffness: 400, mass: 0.8 }}
            >
              <SkillPreview
                card={selected}
                installed={installedNames.has(selected.name)}
                onToggleInstall={toggleInstall}
                onClose={closePreview}
              />
            </motion.div>
          )}
        </AnimatePresence>
      )}
      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-3 px-4 py-4 md:px-8">
          <header className="relative flex h-9 items-center">
            {isMobile && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleSidebar}
                aria-label="Open menu"
                className="size-8 -ml-1 rounded-md text-muted-foreground hover:text-foreground"
              >
                <Menu className="size-[var(--icon-size-lg)]" strokeWidth={1.5} />
              </Button>
            )}
            {!isMobile && canGoBack && (
              <Button
                variant="outline"
                size="lg"
                onClick={() => navigate(-1)}
                className="h-9 gap-1.5 border-border px-3 text-sm"
              >
                <ChevronLeft />
                Skills Page
              </Button>
            )}
            <h1 className="absolute left-1/2 -translate-x-1/2 text-xl leading-tight text-foreground">Marketplace</h1>
          </header>

          {/* Category tabs are visual-only pending backend filter endpoint — selecting a tab does not filter `visible`. */}
          <div className="mt-4 flex flex-col">
            <nav className="-mr-4 flex items-center gap-1 overflow-x-auto pb-2 md:mr-0 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
              {categories.map((c) => (
                <CategoryTab
                  key={c.key}
                  label={c.label}
                  icon={c.icon}
                  active={c.key === activeCategory}
                  onClick={() => setActiveCategory(c.key)}
                />
              ))}
            </nav>
            <div className="-mr-4 h-px bg-border md:mr-0" />
          </div>

          <div className="mt-2 flex items-center gap-3">
            {/* Search input is visual-only pending backend filter endpoint — typing does not filter `visible`. */}
            <div className="relative flex-1">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search Skills"
                className="h-9 rounded-lg border-border pl-9 text-sm placeholder:text-muted-foreground"
              />
            </div>
            <InstallFilterSelect value={filter} onChange={setFilter} />
          </div>

          <div
            className={cn(
              'mt-1 grid gap-3 transition-[grid-template-columns]',
              previewOpen && !isMobile ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2',
            )}
            style={{
              transitionDuration: `${slideMs}ms`,
              transitionTimingFunction: slideEasing,
            }}
          >
            {visible.map((card) => (
              <div
                key={card.name}
                role="button"
                tabIndex={0}
                onClick={() => openPreview(card.name)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openPreview(card.name)
                  }
                }}
                className="cursor-pointer text-left"
              >
                <SkillTile
                  card={card}
                  installed={installedNames.has(card.name)}
                  active={card.name === selectedName}
                  onToggleInstall={() => toggleInstall(card.name)}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {selected && !isMobile && (
        <SlideInAside open={!isClosing}>
          <SkillPreview
            card={selected}
            installed={installedNames.has(selected.name)}
            onToggleInstall={toggleInstall}
            onClose={closePreview}
          />
        </SlideInAside>
      )}
    </section>
  )
}

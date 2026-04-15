import { type ReactNode } from 'react'

type HeaderProps = {
  action?: ReactNode
  banner?: ReactNode
}

export const Header = ({ action, banner }: HeaderProps) => (
  <header className={`fixed inset-x-0 top-0 z-50 ${banner ? '' : 'bg-white/20 backdrop-blur-[32px]'}`}>
    {banner}
    <div className={`mx-auto flex h-[104px] max-w-[1440px] items-center justify-between px-6 lg:px-[160px] ${banner ? 'bg-white/20 backdrop-blur-[32px]' : ''}`}>
      <a href="/" className="flex items-center gap-[7px]">
        <img src="/enterprise/thunderbolt-logo.svg" alt="Thunderbolt" className="size-[23px]" />
        <span className="text-xl font-medium leading-7 tracking-[-0.4px] text-[#101828]">Thunderbolt</span>
      </a>
      {action && <div className="hidden md:block">{action}</div>}
    </div>
  </header>
)

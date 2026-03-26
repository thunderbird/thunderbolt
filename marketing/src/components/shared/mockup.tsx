import type { ReactNode } from 'react'

type MockupProps = {
  children: ReactNode
  className?: string
}

export const Mockup = ({ children, className = '' }: MockupProps) => (
  <div
    className={`overflow-hidden rounded-xl border border-border bg-white shadow-2xl shadow-black/5 ${className}`}
  >
    {/* Window chrome */}
    <div className="flex items-center gap-2 border-b border-border/60 bg-surface-secondary px-4 py-3">
      <div className="size-3 rounded-full bg-red-400/70" />
      <div className="size-3 rounded-full bg-yellow-400/70" />
      <div className="size-3 rounded-full bg-green-400/70" />
      <div className="ml-3 h-5 flex-1 rounded-md bg-border/50" />
    </div>
    <div className="p-0">{children}</div>
  </div>
)

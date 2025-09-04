import { type ReactNode } from 'react'
// import { Sidebar } from '../components/app-sidebar'

export default function Settings({ children }: { children?: ReactNode }) {
  return (
    <>
      <div className="flex flex-col gap-4 p-4 w-full">{children}</div>
    </>
  )
}

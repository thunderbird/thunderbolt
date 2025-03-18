import { Outlet } from 'react-router'
import './index.css'

export default function Layout() {
  return (
    <main className="flex flex-col h-screen w-screen">
      <Outlet />
    </main>
  )
}

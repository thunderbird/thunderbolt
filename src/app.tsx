import { lazy, Suspense } from 'react'
import { AppErrorScreen } from './components/app-error-screen'
import { useAppInitialization } from './hooks/use-app-initialization'
import Loading from './loading'
import { ThemeProvider } from './lib/theme-provider'

const AppContent = lazy(() => import('./app-content'))

export const App = () => {
  const { initData, initError, isInitializing, clearDatabase } = useAppInitialization()

  const renderAppContent = () => {
    if (initError) {
      return <AppErrorScreen error={initError} isClearingDatabase={isInitializing} onClearDatabase={clearDatabase} />
    }

    if (!initData) {
      return <Loading />
    }

    return (
      <Suspense>
        <AppContent initData={initData} />
      </Suspense>
    )
  }

  return (
    <ThemeProvider defaultTheme="system" storageKey="ui_theme">
      {renderAppContent()}
    </ThemeProvider>
  )
}

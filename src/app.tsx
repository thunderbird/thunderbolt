import { lazy, Suspense } from 'react'
import { AppErrorScreen } from './components/app-error-screen'
import { useAppInitialization } from './hooks/use-app-initialization'
import Loading from './loading'
import { ThemeProvider } from './lib/theme-provider'
import { AnimatePresence, motion } from 'framer-motion'

const AppContent = lazy(() => import('./app-content'))

export const App = () => {
  const { initData, initError, isInitializing, clearDatabase } = useAppInitialization()

  const renderAppContent = () => {
    if (initError) {
      return <AppErrorScreen error={initError} isClearingDatabase={isInitializing} onClearDatabase={clearDatabase} />
    }

    return (
      <>
        {initData && (
          <Suspense>
            <AppContent initData={initData} />
          </Suspense>
        )}
        <AnimatePresence>
          {!initData && (
            <motion.div
              className="fixed top-0 left-0 h-full w-full bg-background z-[999]"
              initial={{ opacity: 1 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              // delay the loading animation for 1 second to give time to load lazy loaded components
              // this also avoids the flashing while showing the onboarding dialog
              transition={{ duration: 0.3, delay: 1 }}
            >
              <Loading />
            </motion.div>
          )}
        </AnimatePresence>
      </>
    )
  }

  return (
    <ThemeProvider defaultTheme="system" storageKey="ui_theme">
      {renderAppContent()}
    </ThemeProvider>
  )
}
